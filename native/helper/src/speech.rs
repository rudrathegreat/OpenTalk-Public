use std::{fs::{File, OpenOptions}, io::{Read, Seek, SeekFrom, Write}, path::{Path, PathBuf}, process::{ChildStdin, ChildStdout}, sync::{Arc, Condvar, Mutex, atomic::{AtomicBool, Ordering}}, time::{Duration, Instant}};
use serde_json::json;
use uuid::Uuid;
use super::{Output, MAX_SPOOL, SEGMENT_SAMPLES, OVERLAP_SAMPLES};

pub struct FinalTranscript { pub text: String, pub revision: u32, pub audio_end_sample: u64 }
struct State {
    pcm: Vec<i16>, spool: Option<File>, encoded: Vec<u8>, samples: u64,
    last_voice_sample: u64, finishing: bool, eos: bool,
}
pub struct AudioBuffer { state: Mutex<State>, changed: Condvar, path: PathBuf }
impl AudioBuffer {
    pub fn new(path: PathBuf) -> Self {
        Self { state: Mutex::new(State { pcm: Vec::new(), spool: None, encoded: Vec::new(), samples: 0, last_voice_sample: 0, finishing: false, eos: false }), changed: Condvar::new(), path }
    }
    pub fn append(&self, frame: &[i16]) -> Result<(), String> {
        let mut state = self.state.lock().unwrap();
        if state.eos { return Err("audio_after_eos".into()); }
        let next = state.samples + frame.len() as u64;
        if next * 2 > MAX_SPOOL { return Err("spool_limit".into()); }
        if state.spool.is_none() && next <= SEGMENT_SAMPLES {
            state.pcm.extend_from_slice(frame);
        } else {
            let State { pcm, spool, encoded, samples, .. } = &mut *state;
            if spool.is_none() {
                let mut file = OpenOptions::new().write(true).create_new(true).open(&self.path).map_err(|_| "spool_open")?;
                encoded.clear(); encoded.extend(pcm.iter().flat_map(|s| s.to_le_bytes()));
                file.write_all(encoded).map_err(|_| "spool_write")?;
                pcm.clear(); *spool = Some(file);
            }
            if next * 2 / (1024 * 1024) > *samples * 2 / (1024 * 1024) && !super::disk_headroom(self.path.parent().ok_or("spool_path")?) {
                return Err("disk_headroom".into());
            }
            encoded.clear(); encoded.extend(frame.iter().flat_map(|s| s.to_le_bytes()));
            spool.as_mut().unwrap().write_all(encoded).map_err(|_| "spool_write")?;
        }
        // Scheduling hint only: all samples, including quiet speech, stay in recognition input.
        let energy = frame.iter().map(|s| (*s as f64 / 32768.0).powi(2)).sum::<f64>();
        if !frame.is_empty() && (energy / frame.len() as f64).sqrt() >= 0.003 { state.last_voice_sample = next; }
        state.samples = next;
        drop(state); self.changed.notify_all(); Ok(())
    }
    pub fn request_finish(&self) -> bool {
        let mut state = self.state.lock().unwrap();
        let first = !state.finishing; state.finishing = true;
        drop(state); self.changed.notify_all(); first
    }
    pub fn finish(&self) -> Result<(), String> {
        let mut state = self.state.lock().unwrap();
        if let Some(file) = state.spool.as_mut() { file.flush().map_err(|_| "spool_flush")?; }
        state.finishing = true; state.eos = true;
        drop(state); self.changed.notify_all(); Ok(())
    }
    pub fn wake(&self) { self.changed.notify_all(); }
    pub fn cancel_preview(input: &Arc<Mutex<ChildStdin>>) -> Result<(), String> {
        let mut input = input.lock().unwrap();
        for value in [3u32, 0, 0, 0] { input.write_all(&value.to_le_bytes()).map_err(|_| "worker_write")?; }
        input.flush().map_err(|_| "worker_write".into())
    }
}

fn decode(input: &Arc<Mutex<ChildStdin>>, output: &Arc<Mutex<ChildStdout>>, buffer: &AudioBuffer,
          id: u32, preview: bool, overlap: u32, pcm: &[i16], encoded: &mut Vec<u8>) -> Result<Option<String>, String> {
    encoded.clear(); encoded.extend(pcm.iter().flat_map(|s| s.to_le_bytes()));
    {
        let mut input = input.lock().unwrap();
        // Serialize the decision with stop's cancel write: an obsolete preview cannot start after it.
        if preview && buffer.state.lock().unwrap().finishing { return Ok(None); }
        for value in [if preview { 1 } else { 2 }, id, pcm.len() as u32, overlap] {
            input.write_all(&value.to_le_bytes()).map_err(|_| "worker_write")?;
        }
        input.write_all(encoded).and_then(|_| input.flush()).map_err(|_| "worker_write")?;
    }
    let mut output = output.lock().unwrap(); let mut header = [0u8; 12];
    output.read_exact(&mut header).map_err(|_| "worker_exit")?;
    let reply = u32::from_le_bytes(header[0..4].try_into().unwrap());
    let status = u32::from_le_bytes(header[4..8].try_into().unwrap());
    let length = u32::from_le_bytes(header[8..12].try_into().unwrap()) as usize;
    if reply != id || length > 192000 || status > 1 || (status == 1 && (!preview || length != 0)) { return Err("worker_protocol".into()); }
    let mut text = vec![0; length]; output.read_exact(&mut text).map_err(|_| "worker_read")?;
    if status == 1 { return Ok(None); }
    String::from_utf8(text).map(Some).map_err(|_| "worker_utf8".into())
}

pub fn preview_interval(duration: Duration) -> Duration { Duration::from_secs(2).max(duration.saturating_mul(2)) }
fn cadence(incremental: bool) -> Duration { if incremental { Duration::from_millis(250) } else { Duration::from_secs(2) } }
pub fn transcribe(id: Uuid, buffer: Arc<AudioBuffer>, input: Arc<Mutex<ChildStdin>>, output: Arc<Mutex<ChildStdout>>,
                  canceled: Arc<AtomicBool>, failed: Arc<AtomicBool>, diagnostics: Arc<Output>, incremental: bool) -> Result<FinalTranscript, String> {
    let cadence = cadence(incremental);
    let mut next_preview = Instant::now() + cadence;
    let mut revision = 0u32; let mut position = 0u64; let mut result = String::new(); let mut encoded = Vec::new();
    loop {
        if canceled.load(Ordering::Acquire) { return Err("canceled".into()); }
        if failed.load(Ordering::Acquire) { return Err("capture_failed".into()); }
        let state = buffer.state.lock().unwrap();
        let available = state.samples;
        let long = state.spool.is_some();
        let eos = state.eos;
        if eos && available <= position { return Ok(FinalTranscript { text: result.trim().into(), revision: revision + 1, audio_end_sample: available }); }
        let preview = !long && !eos;
        let eligible = if long { available - position >= SEGMENT_SAMPLES || eos }
            else { eos || (!state.finishing && available >= cadence.as_millis() as u64 * 16 && Instant::now() >= next_preview) };
        if !eligible {
            let wait = if preview && !state.finishing { next_preview.saturating_duration_since(Instant::now()).max(Duration::from_millis(20)) }
                else { Duration::from_secs(2) };
            let _ = buffer.changed.wait_timeout(state, wait).unwrap(); continue;
        }
        let count = if long { (available - position).min(SEGMENT_SAMPLES) } else { available };
        let pause_ms = (available - state.last_voice_sample) / 16;
        let pcm = if long { None } else { Some(state.pcm.clone()) };
        drop(state);
        let pcm = match pcm {
            Some(pcm) => pcm,
            None => read_spool(&buffer.path, position, count)?,
        };
        revision = revision.checked_add(1).ok_or("worker_revision")?;
        let began = Instant::now();
        let text = decode(&input, &output, &buffer, revision, preview, if long && position > 0 { 100 } else { 0 }, &pcm, &mut encoded)?;
        let elapsed = began.elapsed();
        diagnostics.timing(Some(id), if preview { "previewRecognition" } else { "finalRecognition" }, elapsed);
        if canceled.load(Ordering::Acquire) { return Err("canceled".into()); }
        if preview {
            next_preview = began + if incremental { cadence.max(elapsed.saturating_mul(2)) } else { preview_interval(elapsed) };
            if let Some(text) = text {
                if text.len() > 48000 || text.contains('\0') { return Err("context_limit".into()); }
                if !buffer.state.lock().unwrap().finishing {
                    diagnostics.emit(Uuid::new_v4(), Some(id), "transcriptUpdate", json!({"text":text.trim(),"revision":revision,"audioEndSample":available,"pauseMs":pause_ms,"final":false}));
                }
            }
        } else {
            result.push_str(&text.ok_or("worker_protocol")?);
            if result.len() > 48000 || result.contains('\0') { return Err("context_limit".into()); }
            if !long || (eos && position + count >= available) {
                return Ok(FinalTranscript { text: result.trim().into(), revision, audio_end_sample: available });
            }
            position += count - OVERLAP_SAMPLES;
        }
    }
}
fn read_spool(path: &Path, position: u64, count: u64) -> Result<Vec<i16>, String> {
    let mut file = File::open(path).map_err(|_| "spool_read")?;
    file.seek(SeekFrom::Start(position * 2)).map_err(|_| "spool_seek")?;
    let mut bytes = vec![0; count as usize * 2]; file.read_exact(&mut bytes).map_err(|_| "spool_read")?;
    Ok(bytes.chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]])).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn short_capture_is_in_memory_and_finish_follows_last_queued_frame() {
        let path = std::env::temp_dir().join(format!("opentalk-unused-{}.pcm", Uuid::new_v4()));
        let buffer = AudioBuffer::new(path.clone());
        buffer.append(&[5, 6]).unwrap(); buffer.request_finish();
        assert!(!buffer.state.lock().unwrap().eos);
        buffer.append(&[7, 8]).unwrap(); buffer.finish().unwrap();
        let state = buffer.state.lock().unwrap();
        assert!(state.eos); assert_eq!(state.samples, 4); assert_eq!(state.pcm, [5, 6, 7, 8]); assert!(state.spool.is_none()); assert!(!path.exists());
        drop(state); assert!(buffer.append(&[9]).is_err());
    }
    #[test]
    fn preview_work_has_an_adaptive_fifty_percent_duty_budget() {
        assert_eq!(preview_interval(Duration::from_millis(844)), Duration::from_secs(2));
        assert_eq!(preview_interval(Duration::from_millis(1800)), Duration::from_millis(3600));
        assert_eq!(cadence(true), Duration::from_millis(250));
        assert_eq!(cadence(false), Duration::from_secs(2));
    }
    #[test]
    fn quiet_audio_is_preserved_not_removed_by_the_pause_hint() {
        let buffer = AudioBuffer::new(PathBuf::from("not-created.pcm"));
        buffer.append(&[1; 4800]).unwrap();
        let state = buffer.state.lock().unwrap(); assert_eq!(state.samples, 4800); assert_eq!(state.pcm.len(), 4800); assert_eq!(state.last_voice_sample, 0);
    }
    #[test]
    fn overflow_moves_the_complete_prefix_to_spool_without_losing_the_boundary() {
        let root = std::env::temp_dir().join(format!("opentalk-spool-test-{}", Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap(); let path = root.join("fixture.pcm");
        {
            let buffer = AudioBuffer::new(path.clone());
            buffer.append(&vec![1; SEGMENT_SAMPLES as usize]).unwrap();
            assert!(!path.exists()); buffer.append(&[2, 3, 4]).unwrap(); buffer.finish().unwrap();
            let actual = read_spool(&path, SEGMENT_SAMPLES - 2, 5).unwrap();
            assert_eq!(actual, [1, 1, 2, 3, 4]);
            let state = buffer.state.lock().unwrap(); assert_eq!(state.samples, SEGMENT_SAMPLES + 3); assert!(state.pcm.is_empty()); assert!(state.eos);
        }
        std::fs::remove_file(&path).unwrap(); std::fs::remove_dir(&root).unwrap();
    }
    #[test]
    fn exceeding_the_existing_audio_bound_fails_instead_of_truncating() {
        let buffer = AudioBuffer::new(PathBuf::from("not-created.pcm"));
        buffer.state.lock().unwrap().samples = MAX_SPOOL / 2;
        assert_eq!(buffer.append(&[1]).unwrap_err(), "spool_limit");
    }
    #[test]
    #[ignore = "opt-in public-fixture inference; requires native:build and the local verified model"]
    fn public_fixture_final_drain_and_worker_reuse_after_preview_abort() {
        use std::{process::{Command, Stdio}, thread};
        let project = PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().parent().unwrap().to_path_buf();
        let wav = std::fs::read(project.join(".tools/whisper.cpp/samples/jfk.wav")).unwrap();
        let mut position = 12; let mut pcm = Vec::new();
        while position + 8 <= wav.len() {
            let count = u32::from_le_bytes(wav[position+4..position+8].try_into().unwrap()) as usize;
            let start = position + 8;
            if &wav[position..position+4] == b"data" { pcm = wav[start..start+count].chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]])).collect(); }
            position = start + count + count % 2;
        }
        assert!(!pcm.is_empty());
        let incremental = std::env::var("OPENTALK_FIXTURE_MOONSHINE").is_ok_and(|v| v == "1");
        let model = if incremental { ".tools/moonshine-small-streaming-en" } else { ".tools/ggml-base.en.bin" };
        let mut child = Command::new(project.join("native/bin/opentalk-worker.exe")).arg("--model").arg(project.join(model)).arg("--stream")
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().unwrap();
        struct Kill(std::process::Child); impl Drop for Kill { fn drop(&mut self) { let _ = self.0.kill(); let _ = self.0.wait(); } }
        let input = Arc::new(Mutex::new(child.stdin.take().unwrap())); let output = Arc::new(Mutex::new(child.stdout.take().unwrap())); let mut child = Kill(child);
        let mut marker = [0; 4]; output.lock().unwrap().read_exact(&mut marker).unwrap(); assert_eq!(&marker, b"OTW2");
        let buffer = Arc::new(AudioBuffer::new(project.join(".runtime/not-created-public-fixture.pcm")));
        let tail = pcm.len() - if incremental { 2000 } else { 16000 };
        if !incremental { buffer.append(&pcm[..tail]).unwrap(); }
        let canceled = Arc::new(AtomicBool::new(false)); let failed = Arc::new(AtomicBool::new(false));
        let diagnostics = Arc::new(Output { generation: 1, sequence: Mutex::new(0) });
        let b = buffer.clone(); let i = input.clone(); let o = output.clone(); let c = canceled.clone(); let f = failed.clone(); let d = diagnostics.clone();
        let job = thread::spawn(move || transcribe(Uuid::new_v4(), b, i, o, c, f, d, incremental));
        if incremental {
            // Real-time paced synthetic capture through the actual helper scheduler, no microphone.
            for frame in pcm[..tail].chunks(4000) {
                buffer.append(frame).unwrap(); thread::sleep(Duration::from_secs_f64(frame.len() as f64 / 16000.0));
            }
        } else { thread::sleep(Duration::from_millis(2050)); }
        let release = Instant::now();
        buffer.request_finish(); AudioBuffer::cancel_preview(&input).unwrap();
        buffer.append(&pcm[tail..]).unwrap(); buffer.finish().unwrap();
        let final_result = job.join().unwrap().unwrap();
        assert_eq!(final_result.audio_end_sample, pcm.len() as u64);
        let normalize = |text: &str| text.to_lowercase().split(|c:char| !c.is_alphanumeric()).filter(|s| !s.is_empty()).collect::<Vec<_>>().join(" ");
        let normalized = normalize(&final_result.text);
        assert!(normalized.contains("ask not what your country can do for you")); assert!(normalized.contains("ask what you can do for your country"));
        println!("{{\"incrementalMoonshine\":{},\"cpuFixtureStopToFinalMs\":{}}}", incremental, release.elapsed().as_millis());
        let next = Arc::new(AudioBuffer::new(project.join(".runtime/not-created-next-fixture.pcm"))); next.append(&pcm).unwrap(); next.finish().unwrap();
        let again = transcribe(Uuid::new_v4(), next, input.clone(), output.clone(), canceled, failed, diagnostics, incremental).unwrap();
        assert_eq!(normalize(&again.text), normalize(&final_result.text)); assert!(child.0.try_wait().unwrap().is_none());
    }
}
