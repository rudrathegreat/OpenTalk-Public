use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use std::{collections::VecDeque, sync::{Arc, atomic::{AtomicBool, Ordering}, mpsc::{sync_channel, Receiver, RecvTimeoutError, SyncSender}}, thread::{self, JoinHandle}, time::{Duration, Instant}};
use serde_json::{Value, json};

pub const MAX_QUEUE_BLOCKS: usize = 256;
pub const MAX_FRAME_SAMPLES: usize = 16384;
const MIX_FRAME_SAMPLES: usize = 320;
const MAX_MIX_BUFFER_SAMPLES: usize = 16_000;
pub fn level_percent(pcm: &[i16]) -> u8 {
    if pcm.is_empty() { return 0; }
    let mean_square = pcm.iter().map(|sample| {
        let value = *sample as f64;
        value * value
    }).sum::<f64>() / pcm.len() as f64;
    if mean_square <= 1.0 { return 0; }
    let decibels = 20.0 * (mean_square.sqrt() / 32768.0).log10();
    (((decibels + 55.0) / 50.0) * 100.0).clamp(0.0, 100.0).round() as u8
}
pub fn microphones() -> Result<Value, String> {
    let host = cpal::default_host();
    let default = host.default_input_device();
    let mut devices = Vec::new();
    for (index, device) in host.input_devices().map_err(|_| "device_list")?.enumerate() {
        let name = device.name().map_err(|_| "device_name")?;
        let is_default = default.as_ref().is_some_and(|candidate| same_device(&device, candidate));
        // Device index is revalidated against its name; never silently use a new default.
        devices.push(json!({"id":format!("{index}:{name}"), "name":name, "isDefault":is_default}));
    }
    Ok(json!(devices))
}
pub fn playback_devices() -> Result<Value, String> {
    let host = cpal::default_host();
    let default = host.default_output_device();
    let mut devices = Vec::new();
    for (index, device) in host.output_devices().map_err(|_| "device_list")?.enumerate() {
        let name = device.name().map_err(|_| "device_name")?;
        let is_default = default.as_ref().is_some_and(|candidate| same_device(&device, candidate));
        devices.push(json!({"id":format!("{index}:{name}"), "name":name, "isDefault":is_default}));
    }
    Ok(json!(devices))
}
fn same_device(device: &cpal::Device, candidate: &cpal::Device) -> bool {
    match (device.as_inner(), candidate.as_inner()) {
        (cpal::platform::DeviceInner::Wasapi(device), cpal::platform::DeviceInner::Wasapi(candidate)) => device == candidate,
        #[allow(unreachable_patterns)]
        _ => false,
    }
}
fn find_input(id: &str) -> Result<cpal::Device, String> {
    let host = cpal::default_host();
    for (index, device) in host.input_devices().map_err(|_| "devices")?.enumerate() {
        let name = device.name().map_err(|_| "device_name")?;
        if id == format!("{index}:{name}") { return Ok(device); }
    }
    Err("selected_microphone_removed".into())
}
fn find_output(id: &str) -> Result<cpal::Device, String> {
    let host = cpal::default_host();
    for (index, device) in host.output_devices().map_err(|_| "devices")?.enumerate() {
        let name = device.name().map_err(|_| "device_name")?;
        if id == format!("{index}:{name}") { return Ok(device); }
    }
    Err("selected_playback_removed".into())
}

#[derive(Clone, Copy)]
enum Source { Microphone, Playback }
struct SourceFrame { source: Source, pcm: Vec<i16> }

fn mix_sample(microphone: i16, playback: i16) -> i16 {
    (microphone as i32 + playback as i32).clamp(i16::MIN as i32, i16::MAX as i32) as i16
}
fn mixed_frame(microphone: &mut VecDeque<i16>, playback: &mut VecDeque<i16>) -> Vec<i16> {
    (0..MIX_FRAME_SAMPLES).map(|_| mix_sample(microphone.pop_front().unwrap_or(0), playback.pop_front().unwrap_or(0))).collect()
}
fn append_bounded(queue: &mut VecDeque<i16>, pcm: Vec<i16>) -> Result<(), ()> {
    if queue.len().saturating_add(pcm.len()) > MAX_MIX_BUFFER_SAMPLES { return Err(()); }
    queue.extend(pcm); Ok(())
}
fn run_mixer(input: Receiver<SourceFrame>, output: SyncSender<Vec<i16>>, failed: Arc<AtomicBool>) {
    let frame_duration = Duration::from_millis(20);
    let mut microphone = VecDeque::new();
    let mut playback = VecDeque::new();
    let mut next_tick = Instant::now() + frame_duration;
    let mut disconnected = false;
    loop {
        let now = Instant::now();
        if now >= next_tick {
            if disconnected && microphone.is_empty() && playback.is_empty() { break; }
            if output.try_send(mixed_frame(&mut microphone, &mut playback)).is_err() { failed.store(true, Ordering::Release); break; }
            next_tick += frame_duration;
            if next_tick + frame_duration < now { next_tick = now + frame_duration; }
            continue;
        }
        match input.recv_timeout(next_tick.saturating_duration_since(now)) {
            Ok(frame) => {
                let queue = match frame.source { Source::Microphone => &mut microphone, Source::Playback => &mut playback };
                if append_bounded(queue, frame.pcm).is_err() { failed.store(true, Ordering::Release); break; }
            },
            Err(RecvTimeoutError::Timeout) => {},
            Err(RecvTimeoutError::Disconnected) => disconnected = true,
        }
    }
}

fn build_meeting_stream(device: cpal::Device, config: cpal::SupportedStreamConfig, source: Source, sender: SyncSender<SourceFrame>, failed: Arc<AtomicBool>) -> Result<cpal::Stream, String> {
    let channels = config.channels() as usize;
    let rate = config.sample_rate().0;
    if channels == 0 || channels > 32 || !(8000..=192000).contains(&rate) { return Err("device_format".into()); }
    macro_rules! capture {
        ($ty:ty, $convert:expr) => {{
            let fail = failed.clone();
            let error_flag = failed.clone();
            let tx = sender.clone();
            let mut resampler = Resampler::new(rate);
            device.build_input_stream(&config.clone().into(), move |data: &[$ty], _: &cpal::InputCallbackInfo| {
                if fail.load(Ordering::Relaxed) { return; }
                let mono = data.chunks_exact(channels).map(|frame| frame.iter().map($convert).sum::<f32>() / channels as f32);
                let pcm = resampler.process(mono);
                for chunk in pcm.chunks(MAX_FRAME_SAMPLES) {
                    if tx.try_send(SourceFrame { source, pcm: chunk.to_vec() }).is_err() { fail.store(true, Ordering::Release); break; }
                }
            }, move |_| { error_flag.store(true, Ordering::Release); }, None).map_err(|_| "capture_open")?
        }}
    }
    match config.sample_format() {
        cpal::SampleFormat::F32 => Ok(capture!(f32, |v: &f32| *v)),
        cpal::SampleFormat::I16 => Ok(capture!(i16, |v: &i16| *v as f32 / 32768.0)),
        cpal::SampleFormat::U16 => Ok(capture!(u16, |v: &u16| (*v as f32 - 32768.0) / 32768.0)),
        _ => Err("unsupported_device_format".into()),
    }
}

pub struct Capture { streams: Vec<cpal::Stream>, mixer: Option<JoinHandle<()>>, pub failed: Arc<AtomicBool> }
impl Capture {
    pub fn start(id: &str) -> Result<(Self, Receiver<Vec<i16>>), String> {
        let device = find_input(id)?;
        let config = device.default_input_config().map_err(|_| "device_format")?;
        let failed = Arc::new(AtomicBool::new(false));
        let (tx, rx) = sync_channel(MAX_QUEUE_BLOCKS);
        let channels = config.channels() as usize;
        let rate = config.sample_rate().0;
        if channels == 0 || channels > 32 || !(8000..=192000).contains(&rate) { return Err("device_format".into()); }
        let error_flag = failed.clone();
        let mut resampler = Resampler::new(rate);
        macro_rules! capture {
            ($ty:ty, $convert:expr) => {{
                let fail = failed.clone();
                device.build_input_stream(&config.clone().into(), move |data: &[$ty], _: &cpal::InputCallbackInfo| {
                    if fail.load(Ordering::Relaxed) { return; }
                    let mono = data.chunks_exact(channels).map(|frame| frame.iter().map($convert).sum::<f32>() / channels as f32);
                    let pcm = resampler.process(mono);
                    for chunk in pcm.chunks(MAX_FRAME_SAMPLES) {
                        if tx.try_send(chunk.to_vec()).is_err() { fail.store(true, Ordering::Release); break; }
                    }
                }, move |_| { error_flag.store(true, Ordering::Release); }, None).map_err(|_| "capture_open")?
            }}
        }
        let stream = match config.sample_format() {
            cpal::SampleFormat::F32 => capture!(f32, |v: &f32| *v),
            cpal::SampleFormat::I16 => capture!(i16, |v: &i16| *v as f32 / 32768.0),
            cpal::SampleFormat::U16 => capture!(u16, |v: &u16| (*v as f32 - 32768.0) / 32768.0),
            _ => return Err("unsupported_device_format".into()),
        };
        stream.play().map_err(|_| "capture_start")?;
        Ok((Self { streams: vec![stream], mixer: None, failed }, rx))
    }
    pub fn start_meeting(microphone_id: &str, playback_id: &str) -> Result<(Self, Receiver<Vec<i16>>), String> {
        let microphone = find_input(microphone_id)?;
        let playback = find_output(playback_id)?;
        let microphone_config = microphone.default_input_config().map_err(|_| "device_format")?;
        // CPAL's WASAPI backend enables AUDCLNT_STREAMFLAGS_LOOPBACK when a render
        // endpoint is deliberately opened with build_input_stream.
        let playback_config = playback.default_output_config().map_err(|_| "playback_format")?;
        let failed = Arc::new(AtomicBool::new(false));
        let (source_tx, source_rx) = sync_channel(MAX_QUEUE_BLOCKS);
        let microphone_stream = build_meeting_stream(microphone, microphone_config, Source::Microphone, source_tx.clone(), failed.clone())?;
        let playback_stream = build_meeting_stream(playback, playback_config, Source::Playback, source_tx.clone(), failed.clone())?;
        microphone_stream.play().map_err(|_| "capture_start")?;
        playback_stream.play().map_err(|_| "playback_start")?;
        drop(source_tx);
        let (mixed_tx, mixed_rx) = sync_channel(MAX_QUEUE_BLOCKS);
        let mixer_failed = failed.clone();
        let mixer = thread::spawn(move || run_mixer(source_rx, mixed_tx, mixer_failed));
        Ok((Self { streams: vec![microphone_stream, playback_stream], mixer: Some(mixer), failed }, mixed_rx))
    }
    pub fn stop(mut self) {
        self.streams.clear();
        if let Some(mixer) = self.mixer.take() { if mixer.join().is_err() { self.failed.store(true, Ordering::Release); } }
    }
}
// Stateful linear interpolation keeps phase across device buffers. CPU model benchmarking
// must evaluate this converter; a band-limited resampler remains a release gate.
pub struct Resampler { step: f64, position: f64, source_index: u64, previous: f32 }
impl Resampler {
    pub fn new(rate: u32) -> Self { Self { step: rate as f64 / 16000.0, position: 0.0, source_index: 0, previous: 0.0 } }
    pub fn process(&mut self, samples: impl Iterator<Item=f32>) -> Vec<i16> {
        let mut output = Vec::new();
        for sample in samples {
            let current = self.source_index as f64;
            while self.position <= current {
                let alpha = (self.position - (current - 1.0)).clamp(0.0, 1.0) as f32;
                let value = self.previous + (sample - self.previous) * alpha;
                output.push((value.clamp(-1.0, 1.0) * 32767.0).round() as i16);
                self.position += self.step;
            }
            self.previous = sample; self.source_index += 1;
        }
        output
    }
}
#[cfg(test)] mod tests { use super::*;
    #[test] fn resample_phase_survives_buffers() { let audio: Vec<f32>=(0..48000).map(|i| (i as f32 * 0.01).sin()).collect(); let mut whole=Resampler::new(48000); let expected=whole.process(audio.iter().copied()); let mut split=Resampler::new(48000); let actual:Vec<i16>=audio.chunks(137).flat_map(|c|split.process(c.iter().copied())).collect(); assert_eq!(actual,expected); assert_eq!(actual.len(),16000); }
    #[test] fn silence_stays_silent() { let mut r=Resampler::new(44100); assert!(r.process(std::iter::repeat_n(0.0,44100)).iter().all(|s|*s==0)); }
    #[test] fn input_level_is_bounded_and_tracks_signal_strength() { let quiet=level_percent(&[100;160]);let speech=level_percent(&[8000;160]);assert_eq!(level_percent(&[0;160]),0);assert!(speech>quiet);assert!(speech<=100);assert_eq!(level_percent(&[i16::MAX;160]),100); }
    #[test] fn meeting_mix_preserves_solo_sources_and_saturates_overlap() { assert_eq!(mix_sample(1200,0),1200);assert_eq!(mix_sample(0,-900),-900);assert_eq!(mix_sample(20_000,20_000),i16::MAX);assert_eq!(mix_sample(-20_000,-20_000),i16::MIN); }
    #[test] fn meeting_mix_uses_fixed_frames_and_silence_for_an_absent_source() { let mut microphone=VecDeque::from(vec![100;MIX_FRAME_SAMPLES]);let mut playback=VecDeque::from(vec![200;MIX_FRAME_SAMPLES/2]);let mixed=mixed_frame(&mut microphone,&mut playback);assert_eq!(mixed.len(),MIX_FRAME_SAMPLES);assert!(mixed[..MIX_FRAME_SAMPLES/2].iter().all(|sample|*sample==300));assert!(mixed[MIX_FRAME_SAMPLES/2..].iter().all(|sample|*sample==100)); }
    #[test] fn meeting_source_buffers_are_bounded() { let mut queue=VecDeque::new();assert!(append_bounded(&mut queue,vec![0;MAX_MIX_BUFFER_SAMPLES]).is_ok());assert!(append_bounded(&mut queue,vec![0]).is_err()); }
}
