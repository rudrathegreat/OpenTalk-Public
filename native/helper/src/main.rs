mod audio;
mod hotkeys;
mod target;
mod speech;
use std::{cell::Cell, io::{self, BufRead, Read, Write}, fs, path::{Path, PathBuf}, process::{Child, ChildStdin, ChildStdout, Command, Stdio}, sync::{Arc, Mutex, OnceLock, atomic::{AtomicBool, AtomicU8, AtomicU64, Ordering}, mpsc::{sync_channel, SyncSender}}, thread, time::{Duration, Instant}};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use uuid::Uuid;
use hotkeys::{Event, Matcher};
use windows_sys::Win32::{Foundation::*, UI::{WindowsAndMessaging::*, Accessibility::{HWINEVENTHOOK,SetWinEventHook,UnhookWinEvent}}, System::{LibraryLoader::GetModuleHandleW, Threading::{GetCurrentThreadId,GetCurrentProcess,GetCurrentProcessId}, JobObjects::*}};
use windows::{
    core::{implement, Ref},
    Win32::{
        System::Com::{CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED},
        UI::Accessibility::{CUIAutomation, IUIAutomation, IUIAutomationCacheRequest, IUIAutomationElement, IUIAutomationEventHandler, IUIAutomationEventHandler_Impl, TreeScope_Subtree, UIA_EVENT_ID, UIA_Text_TextSelectionChangedEventId},
    },
};

const MAX_CONTROL:usize=256*1024;
const MAX_SPOOL:u64=2*1024*1024*1024;
const SEGMENT_SAMPLES:u64=30*16000;
const OVERLAP_SAMPLES:u64=16000;
const SESSION_RECORDING:u8=0;
const SESSION_TRANSCRIBING:u8=1;
const SESSION_CLEANUP:u8=2;
const SESSION_INSERTING:u8=3;
const SESSION_TERMINAL:u8=4;
static MATCHER:OnceLock<Mutex<Matcher>>=OnceLock::new();
static HOOK_EVENTS:OnceLock<SyncSender<(Event,u64)>>=OnceLock::new();
static EPOCH:OnceLock<Instant>=OnceLock::new();
static HOOK_THREAD:AtomicU64=AtomicU64::new(0);
#[derive(Deserialize,Clone)]
#[serde(deny_unknown_fields)]
struct Request { version:u32,generation:u64,request_id:Uuid,session_id:Option<Uuid>,kind:String,payload:Value }
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
struct Envelope { version:u32,generation:u64,request_id:Uuid,session_id:Option<Uuid>,sequence:u64,#[serde(rename="type")]kind:String,payload:Value }
struct Output { generation:u64,sequence:Mutex<u64> }
impl Output {
    fn timing(&self,session_id:Option<Uuid>,stage:&str,elapsed:Duration){
        if std::env::var("OPENTALK_PERF").is_ok_and(|value|value=="1"){self.emit(Uuid::new_v4(),session_id,"timing",json!({"stage":stage,"durationMs":elapsed.as_secs_f64()*1000.0}));}
    }
    fn emit(&self,request_id:Uuid,session_id:Option<Uuid>,kind:&str,payload:Value) {
        let mut sequence=self.sequence.lock().unwrap(); *sequence+=1;
        let event=Envelope{version:1,generation:self.generation,request_id,session_id,sequence:*sequence,kind:kind.into(),payload};
        let mut output=io::stdout().lock(); if serde_json::to_writer(&mut output,&event).is_ok(){let _=output.write_all(b"\n");let _=output.flush();}
    }
    fn reply(&self,r:&Request,kind:&str,payload:Value){self.emit(r.request_id,r.session_id,kind,payload)}
}
struct SerializedWorker<T:Send+'static> { sender:Option<SyncSender<T>>, handle:Option<thread::JoinHandle<()>> }
impl<T:Send+'static> SerializedWorker<T> {
    fn spawn(bound:usize,mut execute:impl FnMut(T)+Send+'static)->Self {
        let(sender,receiver)=sync_channel(bound);
        let handle=thread::spawn(move||while let Ok(job)=receiver.recv(){execute(job)});
        Self{sender:Some(sender),handle:Some(handle)}
    }
    fn try_send(&self,job:T)->Result<(),String>{self.sender.as_ref().ok_or("insertion_worker")?.try_send(job).map_err(|_|"insertion_busy".into())}
    fn close(&mut self){self.sender.take();if let Some(handle)=self.handle.take(){let _=handle.join();}}
    fn shutdown(mut self){self.close();}
}
impl<T:Send+'static> Drop for SerializedWorker<T> {fn drop(&mut self){self.close();}}
struct InsertionJob { target:target::Target,text:String,authorization:Arc<target::InsertionAuthorization>,output:Arc<Output>,reply:Request,selection:Option<target::Selection> }
struct InsertionCom;
impl InsertionCom {fn initialize()->Result<Self,String>{unsafe{CoInitializeEx(None,COINIT_MULTITHREADED).ok().map_err(|_|"insertion_failed")?;}Ok(Self)}}
impl Drop for InsertionCom {fn drop(&mut self){target::clear_automation();unsafe{CoUninitialize();}}}
fn coordinate_insertion(
    perform:impl FnOnce(&mut dyn FnMut(&str,&str))->(String,String),
    mut acknowledge:impl FnMut(&str,&str,bool),
){
    let mut dispatched=false;
    let result=perform(&mut|outcome,reason|{if !dispatched{dispatched=true;acknowledge(outcome,reason,true);}});
    if !dispatched{acknowledge(&result.0,&result.1,false);}
}
fn run_insertion(job:InsertionJob){
    let began=Instant::now();let dispatched_at=Cell::new(None);
    coordinate_insertion(
        |dispatch|match &job.selection { Some(selection)=>target::replace_selection(selection,&job.text,&job.authorization,|outcome,reason|dispatch(outcome,reason)),None=>target::insert(&job.target,&job.text,&job.authorization,|outcome,reason|dispatch(outcome,reason)) },
        |outcome,reason,dispatched|{
            if dispatched {
                dispatched_at.set(Some(Instant::now()));job.output.timing(job.reply.session_id,"pasteDispatch",began.elapsed());
                job.output.emit(Uuid::new_v4(),job.reply.session_id,"pasteDispatched",json!({}));
            }
            job.output.reply(&job.reply,"insertion",json!({"outcome":outcome,"reason":reason}));
        },
    );
    if let Some(at)=dispatched_at.get(){job.output.timing(job.reply.session_id,"clipboardRestoration",at.elapsed());}
}
unsafe extern "system" fn keyboard(code:i32,w:WPARAM,l:LPARAM)->LRESULT {
    unsafe {
        if code<0 {return CallNextHookEx(std::ptr::null_mut(),code,w,l)}
        let data=&*(l as *const KBDLLHOOKSTRUCT);
        let down=w as u32==WM_KEYDOWN || w as u32==WM_SYSKEYDOWN;
        let injected=data.flags&LLKHF_INJECTED!=0;
        target::record_keyboard_event(data.vkCode,down,injected);
        let now=EPOCH.get().unwrap().elapsed().as_millis()as u64;
        if let Ok(mut matcher)=MATCHER.get().unwrap().try_lock(){
            let (suppress,event,invalidate)=matcher.key(data.vkCode,down,injected,now);
            if invalidate {target::INPUT_GENERATION.fetch_add(1,Ordering::Release);}
            if let Some(event)=event {if HOOK_EVENTS.get().unwrap().try_send((event,0)).is_err(){matcher.enabled=false;}}
            if suppress {return 1}
        }
        CallNextHookEx(std::ptr::null_mut(),code,w,l)
    }
}
unsafe extern "system" fn mouse(code:i32,w:WPARAM,l:LPARAM)->LRESULT {
    unsafe {if code>=0 && [WM_LBUTTONDOWN,WM_RBUTTONDOWN,WM_MBUTTONDOWN,WM_MOUSEWHEEL].contains(&(w as u32)){let data=&*(l as *const MSLLHOOKSTRUCT);let mut process=0;let window=WindowFromPoint(data.pt);if !window.is_null(){GetWindowThreadProcessId(window,&mut process);}if data.flags&1==0&&process!=GetCurrentProcessId()&&!target::is_assistant_window(window){target::INPUT_GENERATION.fetch_add(1,Ordering::Release);}}CallNextHookEx(std::ptr::null_mut(),code,w,l)}
}
unsafe extern "system" fn focus(_hook:HWINEVENTHOOK,_event:u32,_hwnd:HWND,_object:i32,_child:i32,_thread:u32,_time:u32){target::FOCUS_GENERATION.fetch_add(1,Ordering::Release);let _=HOOK_EVENTS.get().unwrap().try_send((Event::FocusChanged,0));}
fn publish_selection_changed(){target::SELECTION_GENERATION.fetch_add(1,Ordering::Release);let _=HOOK_EVENTS.get().unwrap().try_send((Event::SelectionChanged,0));}
unsafe extern "system" fn selection_changed(_hook:HWINEVENTHOOK,_event:u32,_hwnd:HWND,_object:i32,_child:i32,_thread:u32,_time:u32){publish_selection_changed();}
#[implement(IUIAutomationEventHandler)]
struct SelectionAutomationHandler;
impl IUIAutomationEventHandler_Impl for SelectionAutomationHandler_Impl {
    fn HandleAutomationEvent(&self,_sender:Ref<IUIAutomationElement>,event:UIA_EVENT_ID)->windows::core::Result<()> {
        if event==UIA_Text_TextSelectionChangedEventId {publish_selection_changed();}
        Ok(())
    }
}
fn hooks()->Result<(),String>{
    unsafe {
        HOOK_THREAD.store(GetCurrentThreadId()as u64,Ordering::Release);
        let com_initialized=CoInitializeEx(None,COINIT_MULTITHREADED).is_ok();
        // Modern providers publish the UIA event directly. Keep the WinEvent hook
        // below as a compatibility path for legacy/common controls.
        let selection_automation=if com_initialized {
            (||->windows::core::Result<(IUIAutomation,IUIAutomationElement,IUIAutomationEventHandler)>{
                let automation:IUIAutomation=CoCreateInstance(&CUIAutomation,None,CLSCTX_INPROC_SERVER)?;
                let root=automation.GetRootElement()?;
                let handler:IUIAutomationEventHandler=SelectionAutomationHandler.into();
                automation.AddAutomationEventHandler(UIA_Text_TextSelectionChangedEventId,&root,TreeScope_Subtree,None::<&IUIAutomationCacheRequest>,&handler)?;
                Ok((automation,root,handler))
            })().ok()
        }else{None};
        let keyboard_hook=SetWindowsHookExW(WH_KEYBOARD_LL,Some(keyboard),GetModuleHandleW(std::ptr::null()),0);
        let mouse_hook=SetWindowsHookExW(WH_MOUSE_LL,Some(mouse),GetModuleHandleW(std::ptr::null()),0);
        let focus_hook=SetWinEventHook(EVENT_OBJECT_FOCUS,EVENT_OBJECT_FOCUS,std::ptr::null_mut(),Some(focus),0,0,WINEVENT_OUTOFCONTEXT|WINEVENT_SKIPOWNPROCESS);
        let foreground_hook=SetWinEventHook(EVENT_SYSTEM_FOREGROUND,EVENT_SYSTEM_FOREGROUND,std::ptr::null_mut(),Some(focus),0,0,WINEVENT_OUTOFCONTEXT|WINEVENT_SKIPOWNPROCESS);
        let selection_hook=SetWinEventHook(EVENT_OBJECT_TEXTSELECTIONCHANGED,EVENT_OBJECT_TEXTSELECTIONCHANGED,std::ptr::null_mut(),Some(selection_changed),0,0,WINEVENT_OUTOFCONTEXT|WINEVENT_SKIPOWNPROCESS);
        // Selection observation is an assistant-only enhancement. Never make ordinary
        // microphone enumeration/dictation unavailable if Windows cannot install it.
        if keyboard_hook.is_null()||mouse_hook.is_null()||focus_hook.is_null()||foreground_hook.is_null(){return Err("hook_install".into())}
        SetTimer(std::ptr::null_mut(),1,15,None);
        let mut msg:MSG=std::mem::zeroed();
        while GetMessageW(&mut msg,std::ptr::null_mut(),0,0)>0 {
            if msg.message==WM_TIMER {
                if let Ok(mut matcher)=MATCHER.get().unwrap().try_lock(){let now=EPOCH.get().unwrap().elapsed().as_millis()as u64;let delay=matcher.pending_elapsed(now);if let Some(event)=matcher.tick(now){let _=HOOK_EVENTS.get().unwrap().try_send((event,delay));}}
            }
            TranslateMessage(&msg);DispatchMessageW(&msg);
        }
        UnhookWindowsHookEx(keyboard_hook);UnhookWindowsHookEx(mouse_hook);UnhookWinEvent(focus_hook);UnhookWinEvent(foreground_hook);if !selection_hook.is_null(){UnhookWinEvent(selection_hook);}
        if let Some((automation,root,handler))=selection_automation{let _=automation.RemoveAutomationEventHandler(UIA_Text_TextSelectionChangedEventId,&root,&handler);}
        if com_initialized{CoUninitialize();}Ok(())
    }
}
struct Worker { child:Arc<Mutex<Child>>, input:Arc<Mutex<ChildStdin>>, output:Arc<Mutex<ChildStdout>>, model:PathBuf, ready:Arc<AtomicBool>, failed:Arc<AtomicBool>, readiness:Option<thread::JoinHandle<()>>, began:Instant }
impl Worker {
    fn spawn(binary:&Path,model:&Path)->Result<Self,String>{
        let began=Instant::now();
        let mut child=Command::new(binary).arg("--model").arg(model).arg("--stream").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().map_err(|_|"worker_spawn")?;
        let input=child.stdin.take().ok_or("worker_pipe")?;let output=child.stdout.take().ok_or("worker_pipe")?;
        let output=Arc::new(Mutex::new(output));let ready=Arc::new(AtomicBool::new(false));let failed=Arc::new(AtomicBool::new(false));
        let pipe=output.clone();let initialized=ready.clone();let failure=failed.clone();
        let readiness=thread::spawn(move||{let mut marker=[0u8;4];if pipe.lock().unwrap().read_exact(&mut marker).is_ok()&&marker==*b"OTW2"{initialized.store(true,Ordering::Release);}else{failure.store(true,Ordering::Release);}});
        Ok(Self{child:Arc::new(Mutex::new(child)),input:Arc::new(Mutex::new(input)),output,model:model.into(),ready,failed,readiness:Some(readiness),began})
    }
    fn kill(&self){let mut child=self.child.lock().unwrap();let _=child.kill();let _=child.wait();}
    fn alive(&self)->bool{self.child.lock().unwrap().try_wait().is_ok_and(|status|status.is_none())}
}
impl Drop for Worker {fn drop(&mut self){self.kill();if let Some(readiness)=self.readiness.take(){let _=readiness.join();}}}
struct Active {
    id:Uuid,capture:Option<audio::Capture>,buffer:Arc<speech::AudioBuffer>,input:Arc<Mutex<ChildStdin>>,canceled:Arc<AtomicBool>,failed:Arc<AtomicBool>,running:Arc<AtomicBool>,
    worker_failed:Arc<AtomicBool>,phase:Arc<AtomicU8>,writer:Option<thread::JoinHandle<()>>,
    level:Arc<AtomicU8>,job:Option<thread::JoinHandle<Result<speech::FinalTranscript,String>>>,reply:Option<thread::JoinHandle<()>>,
    insertion:Arc<target::InsertionAuthorization>,directory:PathBuf,attempted:bool
}
impl Active {
    fn stop(&mut self){
        if self.buffer.request_finish()&&speech::AudioBuffer::cancel_preview(&self.input).is_err(){self.failed.store(true,Ordering::Release);}
        if let Some(capture)=self.capture.take(){capture.stop();}
        if let Some(writer)=self.writer.take(){if writer.join().is_err(){self.failed.store(true,Ordering::Release);}}
        // EOS is only visible after the capture callback channel has been drained completely.
        if self.buffer.finish().is_err(){self.failed.store(true,Ordering::Release);self.buffer.wake();}
    }
    fn invalidate(&self){self.canceled.store(true,Ordering::Release);self.buffer.wake();self.insertion.invalidate();}
    fn discard(&mut self,worker:&mut Option<Worker>){
        self.invalidate();self.phase.store(SESSION_TERMINAL,Ordering::Release);self.stop();
        if self.running.load(Ordering::Acquire)||self.worker_failed.load(Ordering::Acquire){if let Some(w)=worker.take(){w.kill();}}
        if let Some(job)=self.job.take(){let _=job.join();}if let Some(reply)=self.reply.take(){let _=reply.join();}
        let _=fs::remove_dir_all(&self.directory);
    }
}
fn private_root()->Result<PathBuf,String>{
    let app=std::env::var_os("LOCALAPPDATA").ok_or("user_directory")?;
    let root=PathBuf::from(app).join("OpenTalk").join("spool");fs::create_dir_all(&root).map_err(|_|"spool_create")?;
    // Apply protected current-user/SYSTEM ACL. Fail closed; no shared writable spool.
    let user=std::env::var("USERNAME").map_err(|_|"user_identity")?;
    let acl_binary=PathBuf::from(std::env::var_os("SystemRoot").ok_or("system_directory")?).join("System32").join("icacls.exe");
    let status=Command::new(acl_binary).arg(&root).args(["/inheritance:r","/grant:r"]).arg(format!("{user}:(OI)(CI)F")).arg("*S-1-5-18:(OI)(CI)F").stdout(Stdio::null()).stderr(Stdio::null()).status().map_err(|_|"spool_acl")?;
    if !status.success(){return Err("spool_acl".into())}
    for entry in fs::read_dir(&root).map_err(|_|"spool_read")?{let entry=entry.map_err(|_|"spool_read")?;if entry.file_type().map_err(|_|"spool_type")?.is_dir() && Uuid::parse_str(&entry.file_name().to_string_lossy()).is_ok(){fs::remove_dir_all(entry.path()).map_err(|_|"spool_cleanup")?;}}
    Ok(root)
}
fn disk_headroom(path:&Path)->bool{
    use std::os::windows::ffi::OsStrExt;
    let wide:Vec<u16>=path.as_os_str().encode_wide().chain(Some(0)).collect();let mut available=0u64;
    unsafe{windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW(wide.as_ptr(),&mut available,std::ptr::null_mut(),std::ptr::null_mut())!=0 && available>256*1024*1024}
}
fn verified_model(payload:&Value)->Result<PathBuf,String>{
    let model=PathBuf::from(payload["modelPath"].as_str().ok_or("model")?);
    let allowed=PathBuf::from(std::env::var_os("APPDATA").ok_or("appdata")?).join("OpenTalk").join("models");
    let canonical=model.canonicalize().map_err(|_|"model_missing")?;
    if canonical.parent()!=Some(allowed.canonicalize().map_err(|_|"model_directory")?.as_path()){return Err("model_path".into())}
    if canonical.file_name().and_then(|s|s.to_str())==Some("moonshine-small-streaming-en") {
        if !canonical.is_dir(){return Err("model_path".into())}
        for name in ["adapter.ort","cross_kv.ort","decoder_kv.ort","encoder.ort","frontend.model.ort","frontend.weights.ort","streaming_config.json","tokenizer.bin","decoder_kv_with_attention.ort"] {
            let asset=canonical.join(name);let resolved=asset.canonicalize().map_err(|_|"model_missing")?;
            if !asset.symlink_metadata().map_err(|_|"model_missing")?.file_type().is_file()||resolved.parent()!=Some(canonical.as_path()){return Err("model_path".into())}
        }
    } else if !canonical.is_file()||!["ggml-base.en.bin","ggml-small.en.bin"].contains(&canonical.file_name().and_then(|s|s.to_str()).unwrap_or("")){return Err("model_path".into())}
    Ok(canonical)
}
fn begin(id:Uuid,payload:&Value,root:&Path,worker:&mut Option<Worker>,diagnostics:&Arc<Output>)->Result<Active,String>{
    let mic=payload["microphoneId"].as_str().ok_or("microphone")?;
    let capture_mode=payload["captureMode"].as_str().unwrap_or("microphone");
    let playback=match capture_mode{"microphone"=>None,"meeting"=>Some(payload["playbackDeviceId"].as_str().ok_or("playback")?),_=>return Err("capture_mode".into())};
    let canonical=verified_model(payload)?;
    if !disk_headroom(root){return Err("disk_headroom".into())}
    if worker.as_ref().is_none_or(|w|w.model!=canonical||!w.ready.load(Ordering::Acquire)||!w.alive()){return Err("worker_not_prepared".into())}
    let directory=root.join(id.to_string());fs::create_dir(&directory).map_err(|_|"spool_create")?;
    let buffer=Arc::new(speech::AudioBuffer::new(directory.join("audio.pcm")));
    let capture_began=Instant::now();
    let capture_result=match capture_mode{
        "microphone"=>audio::Capture::start(mic),
        "meeting"=>audio::Capture::start_meeting(mic,playback.unwrap()),
        _=>unreachable!(),
    };
    let (capture,frames)=match capture_result{Ok(v)=>v,Err(e)=>{let _=fs::remove_dir_all(&directory);return Err(e)}};let failed=capture.failed.clone();
    diagnostics.timing(Some(id),"microphoneOpen",capture_began.elapsed());
    let canceled=Arc::new(AtomicBool::new(false));let level=Arc::new(AtomicU8::new(0));
    let worker_failed=Arc::new(AtomicBool::new(false));let phase=Arc::new(AtomicU8::new(SESSION_RECORDING));let insertion=Arc::new(target::InsertionAuthorization::new());
    let writer_failed=failed.clone();let writer_buffer=buffer.clone();let writer_level=level.clone();
    let frame_diagnostics=diagnostics.clone();
    let writer=thread::spawn(move||{
        let mut first=true;
        loop {
            match frames.recv() {
                Ok(pcm)=>{
                    if first&&!pcm.is_empty(){frame_diagnostics.timing(Some(id),"firstAudioFrame",capture_began.elapsed());first=false;}
                    writer_level.fetch_max(audio::level_percent(&pcm),Ordering::AcqRel);
                    if writer_buffer.append(&pcm).is_err(){writer_failed.store(true,Ordering::Release);writer_buffer.wake();break}
                },Err(_)=>break,
            }
        }
    });
    let w=worker.as_ref().unwrap();let input=w.input.clone();let output=w.output.clone();let job_cancel=canceled.clone();let job_failed=failed.clone();
    let job_worker_failed=worker_failed.clone();
    let running=Arc::new(AtomicBool::new(true));let job_running=running.clone();
    let job_buffer=buffer.clone();let job_input=input.clone();let job_diagnostics=diagnostics.clone();
    let incremental=canonical.file_name().and_then(|s|s.to_str())==Some("moonshine-small-streaming-en");
    let job=thread::spawn(move||->Result<speech::FinalTranscript,String>{
        struct ClearRunning(Arc<AtomicBool>);impl Drop for ClearRunning{fn drop(&mut self){self.0.store(false,Ordering::Release);}}
        let _guard=ClearRunning(job_running);
        let result=speech::transcribe(id,job_buffer,job_input,output,job_cancel,job_failed,job_diagnostics,incremental);
        if result.is_err(){job_worker_failed.store(true,Ordering::Release);}result
    });
    Ok(Active{id,capture:Some(capture),buffer,input,canceled,failed,running,worker_failed,phase,writer:Some(writer),level,job:Some(job),reply:None,insertion,directory,attempted:false})
}
fn read_controls(generation:u64,controls:SyncSender<Result<Option<Request>,String>>){
    let result=(||->Result<(),String>{
        let mut reader=io::stdin().lock();let mut buffer=Vec::new();
        loop {
            buffer.clear();let n=reader.by_ref().take(MAX_CONTROL as u64+1).read_until(b'\n',&mut buffer).map_err(|_|"control_read")?;
            if n==0{controls.send(Ok(None)).map_err(|_|"control_closed")?;return Ok(())}if n>MAX_CONTROL||buffer.last()!=Some(&b'\n'){return Err("control_size".into())}
            let mut raw:Value=serde_json::from_slice(&buffer).map_err(|_|"control_json")?;let object=raw.as_object_mut().ok_or("control_object")?;
            for(from,to)in[("requestId","request_id"),("sessionId","session_id"),("type","kind")]{if let Some(value)=object.remove(from){object.insert(to.into(),value);}}
            let request:Request=serde_json::from_value(raw).map_err(|_|"control_schema")?;
            if request.version!=1||request.generation!=generation{return Err("control_version".into())}
            controls.send(Ok(Some(request))).map_err(|_|"control_closed")?;
        }
    })();
    if let Err(error)=result{let _=controls.send(Err(error));}
}
fn run()->Result<(),String>{
    // The job handle is deliberately not inherited. Abrupt helper death closes it
    // and terminates every worker, preventing orphaned inference after parent exit.
    let job_handle=unsafe{
        let handle=CreateJobObjectW(std::ptr::null(),std::ptr::null());if handle.is_null(){return Err("job_create".into())}
        let mut limits:JOBOBJECT_EXTENDED_LIMIT_INFORMATION=std::mem::zeroed();limits.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if SetInformationJobObject(handle,JobObjectExtendedLimitInformation,&limits as *const _ as *const _,std::mem::size_of_val(&limits)as u32)==0||AssignProcessToJobObject(handle,GetCurrentProcess())==0{CloseHandle(handle);return Err("job_assign".into())}handle
    };
    let args:Vec<String>=std::env::args().collect();let value=|name:&str|args.iter().position(|a|a==name).and_then(|i|args.get(i+1)).cloned().ok_or("arguments");
    let generation=value("--generation")?.parse::<u64>().map_err(|_|"generation")?;let worker_binary=PathBuf::from(value("--worker")?);
    if worker_binary.file_name().and_then(|s|s.to_str())!=Some("opentalk-worker.exe") || worker_binary.parent()!=std::env::current_exe().ok().as_ref().and_then(|p|p.parent()){return Err("worker_path".into())}
    let output=Arc::new(Output{generation,sequence:Mutex::new(0)});let root=private_root()?;
    EPOCH.set(Instant::now()).ok();MATCHER.set(Mutex::new(Matcher::default())).ok();let (events,events_rx)=sync_channel(32);HOOK_EVENTS.set(events).ok();
    let hook=thread::spawn(hooks);let hotkey_output=output.clone();
    thread::spawn(move||while let Ok((event,delay))=events_rx.recv(){if event==Event::Start{hotkey_output.timing(None,"shortcutRecognition",Duration::from_millis(delay));}hotkey_output.emit(Uuid::new_v4(),None,match event{Event::Start=>"started",Event::Stop=>"stopped",Event::Cancel=>"cancel",Event::Meeting=>"meeting",Event::SelectionChanged=>"selectionChanged",Event::FocusChanged=>"focusChanged"},json!({}));});
    unsafe{CoInitializeEx(None,COINIT_MULTITHREADED).ok().map_err(|_|"com")?;}
    output.emit(Uuid::new_v4(),None,"ready",json!({}));
    let mut active:Option<Active>=None;let mut worker:Option<Worker>=None;let mut preparation:Option<Request>=None;
    let mut insertion_com:Option<InsertionCom>=None;let mut insertion_failed=false;
    let insertions=SerializedWorker::spawn(1,move|job:InsertionJob|{
        if insertion_com.is_none()&&!insertion_failed{match InsertionCom::initialize(){Ok(com)=>insertion_com=Some(com),Err(_)=>insertion_failed=true}}
        if insertion_failed{job.output.reply(&job.reply,"error",json!({"code":"insertion_failed"}));}else{run_insertion(job);}
    });
    let(controls,control_rx)=sync_channel(16);let control=thread::spawn(move||read_controls(generation,controls));let mut fatal=None;let mut last_level=Instant::now();
    loop {
        let request=match control_rx.recv_timeout(Duration::from_millis(20)){
            Ok(Ok(Some(request)))=>Some(request),Ok(Ok(None))=>break,Ok(Err(error))=>{fatal=Some(error);break},
            Err(std::sync::mpsc::RecvTimeoutError::Timeout)=>None,Err(std::sync::mpsc::RecvTimeoutError::Disconnected)=>{fatal=Some("control_closed".into());break},
        };
        if let Some(request)=request {
            let result=(||->Result<(),String>{match request.kind.as_str(){
            "listMicrophones"=>output.reply(&request,"microphones",audio::microphones()?),
            "listPlaybackDevices"=>output.reply(&request,"playbackDevices",audio::playback_devices()?),
            "configure"=>{let enabled=request.payload["enabled"].as_bool().ok_or("enabled")?;let hold=request.payload["hold"].as_str().ok_or("hold")?;let hands=request.payload["handsFree"].as_str().ok_or("hands")?;MATCHER.get().unwrap().lock().unwrap().configure(enabled,hold,hands)?;if !enabled{if let Some(a)=active.as_mut(){a.discard(&mut worker);}active=None;drop(worker.take());if let Some(pending)=preparation.take(){output.reply(&pending,"error",json!({"code":"preparation_canceled"}));}}output.reply(&request,"target",json!({}));},
            "prepareWorker"=>{
                let model=verified_model(&request.payload)?;
                if worker.as_ref().is_some_and(|w|w.model==model&&w.ready.load(Ordering::Acquire)&&w.alive()){output.reply(&request,"workerReady",json!({"workerPid":worker.as_ref().unwrap().child.lock().unwrap().id()}));}
                else {
                    if active.is_some()||preparation.is_some(){return Err("worker_busy".into())}
                    drop(worker.take());worker=Some(Worker::spawn(&worker_binary,&model)?);preparation=Some(request.clone());
                }
            },
            "inspectTarget"=>output.reply(&request,"target",serde_json::to_value(target::inspect()?).map_err(|_|"target")?),
            "inspectSelection"=>output.reply(&request,"target",serde_json::to_value(target::inspect_selection()?).map_err(|_|"selection")?),
            "registerAssistantWindow"=>{let handle=request.payload["handle"].as_str().ok_or("assistant_window")?.parse::<usize>().map_err(|_|"assistant_window")?;target::register_assistant_window(handle)?;output.reply(&request,"target",json!({}));},
            "startCapture"=>{if active.is_some(){return Err("session_busy".into())}let id=request.session_id.ok_or("session")?;MATCHER.get().unwrap().lock().unwrap().set_session_active(true);match begin(id,&request.payload,&root,&mut worker,&output){Ok(value)=>active=Some(value),Err(error)=>{MATCHER.get().unwrap().lock().unwrap().set_session_active(false);return Err(error)}};output.reply(&request,"started",json!({}));},
            "stopCapture"=>{let a=active.as_mut().filter(|a|Some(a.id)==request.session_id).ok_or("session")?;a.stop();if a.failed.load(Ordering::Acquire){a.phase.store(SESSION_TERMINAL,Ordering::Release);return Err("capture_failed".into())}output.reply(&request,"stopped",json!({}));},
            "transcribe"=>{let a=active.as_mut().filter(|a|Some(a.id)==request.session_id).ok_or("session")?;if a.capture.is_some(){return Err("capture_active".into())}let job=a.job.take().ok_or("transcribe_duplicate")?;a.phase.store(SESSION_TRANSCRIBING,Ordering::Release);let phase=a.phase.clone();let canceled=a.canceled.clone();let output=output.clone();let reply=request.clone();a.reply=Some(thread::spawn(move||{let result=job.join();if canceled.load(Ordering::Acquire){return;}match result{Ok(Ok(result))=>{phase.store(SESSION_CLEANUP,Ordering::Release);output.reply(&reply,"transcript",json!({"text":result.text,"revision":result.revision,"audioEndSample":result.audio_end_sample,"final":true}));},_=>{phase.store(SESSION_TERMINAL,Ordering::Release);output.reply(&reply,"error",json!({"code":"transcription_failed"}));}}}));},
            "insertText"=>{let a=active.as_mut().filter(|a|Some(a.id)==request.session_id).ok_or("session")?;if a.attempted||a.canceled.load(Ordering::Acquire){return Err("insertion_duplicate_or_canceled".into())}let insertion_target:target::Target=serde_json::from_value(request.payload["target"].clone()).map_err(|_|"target_schema")?;let text=request.payload["text"].as_str().ok_or("text")?.to_owned();let job=InsertionJob{target:insertion_target,text,authorization:a.insertion.clone(),output:output.clone(),reply:request.clone(),selection:None};insertions.try_send(job)?;a.attempted=true;a.phase.store(SESSION_INSERTING,Ordering::Release);},
            "replaceSelection"=>{let a=active.as_mut().filter(|a|Some(a.id)==request.session_id).ok_or("session")?;if a.attempted||a.canceled.load(Ordering::Acquire){return Err("insertion_duplicate_or_canceled".into())}let selection:target::Selection=serde_json::from_value(request.payload["selection"].clone()).map_err(|_|"selection_schema")?;let text=request.payload["text"].as_str().ok_or("text")?.to_owned();let job=InsertionJob{target:selection.target.clone(),text,authorization:a.insertion.clone(),output:output.clone(),reply:request.clone(),selection:Some(selection)};insertions.try_send(job)?;a.attempted=true;a.phase.store(SESSION_INSERTING,Ordering::Release);},
            "invalidate"=>{if let Some(a)=active.as_ref().filter(|a|Some(a.id)==request.session_id){a.invalidate();MATCHER.get().unwrap().lock().unwrap().set_session_active(false);}output.reply(&request,"target",json!({}));},
            "discard"=>{if active.as_ref().is_some_and(|a|Some(a.id)==request.session_id){if let Some(a)=active.as_mut(){a.discard(&mut worker);}active=None;MATCHER.get().unwrap().lock().unwrap().set_session_active(false);}if worker.is_none(){output.emit(Uuid::new_v4(),None,"workerUnavailable",json!({}));}output.reply(&request,"target",json!({}));},
            "testMicrophone"=>{if active.is_some(){return Err("busy".into())}let(capture,frames)=audio::Capture::start(request.payload["microphoneId"].as_str().ok_or("microphone")?)?;let flag=capture.failed.clone();let deadline=Instant::now()+Duration::from_secs(3);let mut non_silent=false;while Instant::now()<deadline{if let Ok(pcm)=frames.recv_timeout(Duration::from_millis(50)){non_silent|=pcm.iter().any(|x|x.unsigned_abs()>300)}}capture.stop();if flag.load(Ordering::Acquire){return Err("capture_failed".into())}output.reply(&request,"target",json!({"signalDetected":non_silent}));},
            _=>return Err("control_type".into()),
            }Ok(())})();
            if let Err(code)=result{output.reply(&request,"error",json!({"code":code}));}
        }
        if preparation.is_some(){
            let w=worker.as_ref().unwrap();
            if w.ready.load(Ordering::Acquire){let pending=preparation.take().unwrap();output.reply(&pending,"workerReady",json!({"workerPid":w.child.lock().unwrap().id()}));}
            else if w.failed.load(Ordering::Acquire)||!w.alive()||w.began.elapsed()>=Duration::from_secs(60){drop(worker.take());let pending=preparation.take().unwrap();output.reply(&pending,"error",json!({"code":"worker_initialization"}));}
        }
        if active.is_none()&&preparation.is_none()&&worker.as_ref().is_some_and(|w|!w.alive()||w.failed.load(Ordering::Acquire)){
            drop(worker.take());output.emit(Uuid::new_v4(),None,"workerUnavailable",json!({}));
        }
        let failure=active.as_ref().and_then(|a|{
            let phase=a.phase.load(Ordering::Acquire);
            if a.failed.load(Ordering::Acquire)&&phase==SESSION_RECORDING{Some("capture_failed")}
            else if a.worker_failed.load(Ordering::Acquire)&&phase==SESSION_RECORDING{Some("transcription_failed")}
            else if (phase==SESSION_RECORDING||phase==SESSION_CLEANUP)&&worker.as_ref().is_some_and(|value|!value.alive()){Some("worker_exit")}
            else{None}
        });
        if let Some(reason)=failure{let id=active.as_ref().unwrap().id;if let Some(a)=active.as_mut(){a.discard(&mut worker);}active=None;MATCHER.get().unwrap().lock().unwrap().set_session_active(false);output.emit(Uuid::new_v4(),Some(id),"error",json!({"code":reason}));}
        if last_level.elapsed()>=Duration::from_millis(80){
            if let Some(a)=active.as_ref().filter(|value|value.phase.load(Ordering::Acquire)==SESSION_RECORDING){output.emit(Uuid::new_v4(),Some(a.id),"audioLevel",json!({"level":a.level.swap(0,Ordering::AcqRel)}));}
            last_level=Instant::now();
        }
    }
    if let Some(a)=active.as_mut(){a.discard(&mut worker);}MATCHER.get().unwrap().lock().unwrap().set_session_active(false);drop(worker);insertions.shutdown();let _=control.join();
    target::clear_automation();unsafe{PostThreadMessageW(HOOK_THREAD.load(Ordering::Acquire)as u32,WM_QUIT,0,0);CoUninitialize();}let _=hook.join();
    // Closing this self-containing job would terminate the helper immediately;
    // process exit releases it after orderly child cleanup.
    let _=job_handle;if let Some(error)=fatal{Err(error)}else{Ok(())}
}
fn main(){if run().is_err(){std::process::exit(1);}}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc::{channel,RecvTimeoutError};

    #[test]
    fn insertion_acknowledgment_precedes_restoration_completion() {
        let(ack_tx,ack_rx)=channel();let(release_tx,release_rx)=channel();let(restored_tx,restored_rx)=channel();
        let job=thread::spawn(move||{
            coordinate_insertion(
                |dispatch|{
                    dispatch("attempted","sent_once");
                    release_rx.recv().unwrap();restored_tx.send(()).unwrap();
                    ("attempted".into(),"sent_once".into())
                },
                |outcome,reason,dispatched|ack_tx.send((outcome.to_owned(),reason.to_owned(),dispatched)).unwrap(),
            );
        });
        assert_eq!(ack_rx.recv_timeout(Duration::from_secs(1)).unwrap(),("attempted".into(),"sent_once".into(),true));
        assert_eq!(restored_rx.recv_timeout(Duration::from_millis(25)),Err(RecvTimeoutError::Timeout));
        release_tx.send(()).unwrap();assert_eq!(restored_rx.recv_timeout(Duration::from_secs(1)),Ok(()));job.join().unwrap();
    }

    #[test]
    fn serialized_worker_cancels_queued_insertion_and_drains_on_shutdown() {
        struct Synthetic { id:u8,authorization:Arc<target::InsertionAuthorization> }
        let(release_tx,release_rx)=channel();let(result_tx,result_rx)=channel();let(done_tx,done_rx)=channel();let sends=Arc::new(AtomicU64::new(0));let worker_sends=sends.clone();
        let mut first_release=Some(release_rx);
        let worker=SerializedWorker::spawn(1,move|job:Synthetic|{
            let committed=job.authorization.try_commit();if committed{worker_sends.fetch_add(1,Ordering::AcqRel);}result_tx.send((job.id,committed)).unwrap();
            if job.id==1{first_release.take().unwrap().recv().unwrap();}
        });
        let first=Arc::new(target::InsertionAuthorization::new());let second=Arc::new(target::InsertionAuthorization::new());
        worker.try_send(Synthetic{id:1,authorization:first}).unwrap();
        assert_eq!(result_rx.recv_timeout(Duration::from_secs(1)),Ok((1,true)));
        worker.try_send(Synthetic{id:2,authorization:second.clone()}).unwrap();assert!(second.invalidate());
        let shutdown=thread::spawn(move||{worker.shutdown();done_tx.send(()).unwrap();});
        assert_eq!(result_rx.recv_timeout(Duration::from_millis(25)),Err(RecvTimeoutError::Timeout));
        assert_eq!(done_rx.recv_timeout(Duration::from_millis(25)),Err(RecvTimeoutError::Timeout));
        release_tx.send(()).unwrap();assert_eq!(result_rx.recv_timeout(Duration::from_secs(1)),Ok((2,false)));
        assert_eq!(done_rx.recv_timeout(Duration::from_secs(1)),Ok(()));shutdown.join().unwrap();assert_eq!(sends.load(Ordering::Acquire),1);
    }
}
