use std::{cell::RefCell, mem::size_of, ptr::null_mut, sync::{Mutex, OnceLock, atomic::{AtomicU8, AtomicU64, AtomicUsize, Ordering}}, thread, time::Duration};
use serde::{Deserialize, Serialize};
use windows::Win32::{Foundation::HWND as AutomationHwnd, System::{Com::{CoCreateInstance, CLSCTX_INPROC_SERVER}, Ole::{SafeArrayAccessData, SafeArrayUnaccessData, SafeArrayGetDim, SafeArrayGetVartype, SafeArrayGetLBound, SafeArrayGetUBound, SafeArrayDestroy}, Variant::VT_R8}, UI::Accessibility::{CUIAutomation, IUIAutomation, IUIAutomationElement, IUIAutomationTextPattern, UIA_TextPatternId, UIA_EditControlTypeId, UIA_DocumentControlTypeId}};
use windows_sys::Win32::{Foundation::*, Security::*, System::{Threading::*, Memory::*, DataExchange::*, StationsAndDesktops::*}, UI::{WindowsAndMessaging::*, Input::KeyboardAndMouse::*}};
pub static INPUT_GENERATION: AtomicU64 = AtomicU64::new(0);
pub static FOCUS_GENERATION: AtomicU64 = AtomicU64::new(0);
pub static SELECTION_GENERATION: AtomicU64 = AtomicU64::new(0);
static ASSISTANT_WINDOW: AtomicUsize = AtomicUsize::new(0);
static CLIPBOARD_RESTORE_DELAY: OnceLock<Duration> = OnceLock::new();
static PHYSICAL_KEYS:[AtomicU64;4]=[const{AtomicU64::new(0)};4];
static SYNTHETIC_INPUT:Mutex<()>=Mutex::new(());
thread_local! { static AUTOMATION: RefCell<Option<IUIAutomation>> = const { RefCell::new(None) }; }
// Cached only on its COM-owning thread, and released before CoUninitialize.
pub fn clear_automation() { AUTOMATION.with(|slot| { slot.borrow_mut().take(); }); }
const INSERT_AUTHORIZED: u8 = 0;
const INSERT_COMMITTED: u8 = 1;
const INSERT_INVALIDATED: u8 = 2;
pub fn register_assistant_window(handle:usize) -> Result<(),String> {
    if handle==0 || unsafe{IsWindow(handle as HWND)}==0 { return Err("assistant_window".into()); }
    ASSISTANT_WINDOW.store(handle,Ordering::Release);Ok(())
}
pub fn is_assistant_window(window:HWND)->bool {
    let assistant=ASSISTANT_WINDOW.load(Ordering::Acquire) as HWND;
    !window.is_null() && !assistant.is_null() && (window==assistant || unsafe{GetAncestor(window,GA_ROOT)}==assistant)
}
pub struct InsertionAuthorization(AtomicU8);
impl InsertionAuthorization {
    pub fn new() -> Self { Self(AtomicU8::new(INSERT_AUTHORIZED)) }
    pub fn invalidate(&self) -> bool { self.0.compare_exchange(INSERT_AUTHORIZED, INSERT_INVALIDATED, Ordering::AcqRel, Ordering::Acquire).is_ok() }
    fn authorized(&self) -> bool { self.0.load(Ordering::Acquire) == INSERT_AUTHORIZED }
    pub(crate) fn try_commit(&self) -> bool { self.0.compare_exchange(INSERT_AUTHORIZED, INSERT_COMMITTED, Ordering::AcqRel, Ordering::Acquire).is_ok() }
}
pub fn record_keyboard_event(key:u32,down:bool,injected:bool){
    if injected||key>255{return}
    let index=key as usize/64;let mask=1u64<<(key as usize%64);
    if down{PHYSICAL_KEYS[index].fetch_or(mask,Ordering::AcqRel);}else{PHYSICAL_KEYS[index].fetch_and(!mask,Ordering::AcqRel);}
}
fn raw_physical_key_down(key:u16)->bool{
    let index=key as usize/64;let mask=1u64<<(key as usize%64);
    PHYSICAL_KEYS[index].load(Ordering::Acquire)&mask!=0
}
fn physical_key_down(key:u16)->bool{
    match key{
        VK_CONTROL=>raw_physical_key_down(VK_CONTROL)||raw_physical_key_down(VK_LCONTROL)||raw_physical_key_down(VK_RCONTROL),
        VK_SHIFT=>raw_physical_key_down(VK_SHIFT)||raw_physical_key_down(VK_LSHIFT)||raw_physical_key_down(VK_RSHIFT),
        VK_MENU=>raw_physical_key_down(VK_MENU)||raw_physical_key_down(VK_LMENU)||raw_physical_key_down(VK_RMENU),
        _=>raw_physical_key_down(key),
    }
}
#[derive(Clone,Copy,Debug,PartialEq,Eq)]
struct ShortcutStroke{key:u16,up:bool}
fn shortcut_strokes(action:u16)->[ShortcutStroke;4]{[
    ShortcutStroke{key:VK_CONTROL,up:false},ShortcutStroke{key:action,up:false},
    ShortcutStroke{key:action,up:true},ShortcutStroke{key:VK_CONTROL,up:true},
]}
fn synthetically_owned(strokes:&[ShortcutStroke],inserted:usize)->Vec<u16>{
    let mut owned=Vec::new();
    for stroke in strokes.iter().take(inserted.min(strokes.len())){
        if stroke.up{if let Some(index)=owned.iter().rposition(|key|*key==stroke.key){owned.remove(index);}}
        else{owned.push(stroke.key);}
    }
    owned
}
fn owned_release_strokes(owned:&[u16],physical:impl Fn(u16)->bool)->Vec<ShortcutStroke>{
    owned.iter().rev().filter(|key|!physical(**key)).map(|key|ShortcutStroke{key:*key,up:true}).collect()
}
fn shortcut_preflight(action:u16)->Result<(),String>{
    for key in[VK_CONTROL,VK_MENU,VK_SHIFT,VK_LWIN,VK_RWIN]{
        if physical_key_down(key)||unsafe{GetAsyncKeyState(key as i32)<0}{return Err("modifier_held".into())}
    }
    if physical_key_down(action)||unsafe{GetAsyncKeyState(action as i32)<0}{return Err("shortcut_key_held".into())}
    Ok(())
}
fn send_strokes(strokes:&[ShortcutStroke],marker:usize)->usize{
    let inputs:Vec<INPUT>=strokes.iter().map(|stroke|{
        let mut input:INPUT=unsafe{std::mem::zeroed()};input.r#type=INPUT_KEYBOARD;
        input.Anonymous.ki=KEYBDINPUT{wVk:stroke.key,wScan:0,dwFlags:if stroke.up{KEYEVENTF_KEYUP}else{0},time:0,dwExtraInfo:marker};input
    }).collect();
    if inputs.is_empty(){0}else{unsafe{SendInput(inputs.len()as u32,inputs.as_ptr(),size_of::<INPUT>()as i32)as usize}}
}
fn send_shortcut(action:u16,marker:usize)->Result<(),String>{
    let _gate=SYNTHETIC_INPUT.lock().map_err(|_|"input_gate")?;
    shortcut_preflight(action)?;
    let strokes=shortcut_strokes(action);let inserted=send_strokes(&strokes,marker);
    if inserted==strokes.len(){return Ok(())}
    let mut owned=synthetically_owned(&strokes,inserted);
    // At most two keys can be owned by the four-event batch. Cleanup is bounded
    // and never releases a key whose physical down transition OpenTalk observed.
    for _ in 0..2{
        let releases=owned_release_strokes(&owned,physical_key_down);if releases.is_empty(){break}
        let released=send_strokes(&releases,marker).min(releases.len());if released==0{break}
        for stroke in releases.iter().take(released){if let Some(index)=owned.iter().rposition(|key|*key==stroke.key){owned.remove(index);}}
        if owned.is_empty(){break}
    }
    Err("input_acknowledgment".into())
}
#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(deny_unknown_fields)]
pub struct Target { hwnd: usize, process: u32, runtime: Vec<i32>, native: usize, input_generation: u64, focus_generation: u64, selection_generation: u64, terminal: bool }
#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(deny_unknown_fields)]
pub struct SelectionBounds { x:i32,y:i32,width:i32,height:i32 }
#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(rename_all="camelCase")]
enum SelectionCapture { Automation, Clipboard }
#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(deny_unknown_fields)]
pub struct Selection { pub target:Target,text:String,bounds:SelectionBounds,capture:SelectionCapture }
// GetFocusedElement can fail while the focused provider is still valid; Microsoft
// explicitly recommends handling that acquisition error by trying the call again.
fn focused_element_with_retry<T,E>(mut lookup:impl FnMut()->Result<T,E>,mut pause:impl FnMut())->Result<T,String> {
    match lookup(){Ok(element)=>Ok(element),Err(_)=>{pause();lookup().map_err(|_|"focus_element".into())}}
}
unsafe fn is_focused_input(element:&IUIAutomationElement,process:u32)->bool{
    unsafe{
        element.CurrentProcessId().is_ok_and(|value|value as u32==process)
            && element.CurrentHasKeyboardFocus().is_ok_and(|value|value.as_bool())
            && element.CurrentControlType().is_ok_and(|kind|kind==UIA_EditControlTypeId||kind==UIA_DocumentControlTypeId)
    }
}
unsafe fn has_nonempty_selection(element:&IUIAutomationElement)->bool{
    unsafe{
        let Ok(pattern):Result<IUIAutomationTextPattern,_>=element.GetCurrentPatternAs(UIA_TextPatternId)else{return false};
        let Ok(ranges)=pattern.GetSelection()else{return false};
        if ranges.Length().ok()!=Some(1){return false}
        ranges.GetElement(0).ok().and_then(|range|range.GetText(1).ok()).is_some_and(|text|!text.is_empty())
    }
}
unsafe fn find_focused_input(automation:&IUIAutomation,window:HWND,process:u32)->Result<IUIAutomationElement,String>{
    unsafe{
        let root=automation.ElementFromHandle(AutomationHwnd(window)).map_err(|_|"focus_element")?;
        let walker=automation.ControlViewWalker().map_err(|_|"focus_element")?;
        let mut pending=vec![root];let mut visited=0usize;let mut selected=None;
        while let Some(element)=pending.pop(){
            visited+=1;if visited>256{return Err("focus_tree_limit".into())}
            if is_focused_input(&element,process){return Ok(element)}
            let same_process=element.CurrentProcessId().is_ok_and(|value|value as u32==process);
            let text_control=element.CurrentControlType().is_ok_and(|kind|kind==UIA_EditControlTypeId||kind==UIA_DocumentControlTypeId);
            if same_process&&text_control&&has_nonempty_selection(&element){
                if let Some(existing)=selected.as_ref(){
                    if !automation.CompareElements(existing,&element).is_ok_and(|same|same.as_bool()){return Err("selection_ambiguous".into())}
                }else{selected=Some(element.clone());}
            }
            let mut child=walker.GetFirstChildElement(&element).ok();
            while let Some(current)=child{
                if pending.len()>=256{return Err("focus_tree_limit".into())}
                child=walker.GetNextSiblingElement(&current).ok();pending.push(current);
            }
        }
        selected.ok_or_else(||"unverifiable_input".into())
    }
}
unsafe fn runtime_id(element:&IUIAutomationElement)->Result<Vec<i32>,String>{
    unsafe{
        let array=element.GetRuntimeId().map_err(|_|"runtime_id")?;
        let runtime=(|| -> Result<Vec<i32>,String> {
            let lower=SafeArrayGetLBound(array,1).map_err(|_|"runtime_id")?;
            let upper=SafeArrayGetUBound(array,1).map_err(|_|"runtime_id")?;
            if upper < lower || upper-lower>64 { return Err("runtime_size".into()); }
            let mut data=null_mut(); SafeArrayAccessData(array,&mut data).map_err(|_|"runtime_data")?;
            let values=std::slice::from_raw_parts(data as *const i32,(upper-lower+1)as usize).to_vec();
            let _=SafeArrayUnaccessData(array); Ok(values)
        })();
        let _=SafeArrayDestroy(array);let runtime=runtime?;
        if runtime.is_empty(){Err("runtime_empty".into())}else{Ok(runtime)}
    }
}
unsafe fn find_input_by_runtime(automation:&IUIAutomation,window:HWND,process:u32,expected:&[i32])->Result<IUIAutomationElement,String>{
    unsafe{
        let root=automation.ElementFromHandle(AutomationHwnd(window)).map_err(|_|"focus_element")?;
        let walker=automation.ControlViewWalker().map_err(|_|"focus_element")?;
        let mut pending=vec![root];let mut visited=0usize;
        while let Some(element)=pending.pop(){
            visited+=1;if visited>256{return Err("focus_tree_limit".into())}
            let same_process=element.CurrentProcessId().is_ok_and(|value|value as u32==process);
            let text_control=element.CurrentControlType().is_ok_and(|kind|kind==UIA_EditControlTypeId||kind==UIA_DocumentControlTypeId);
            if same_process&&text_control&&runtime_id(&element).as_deref()==Ok(expected){return Ok(element)}
            let mut child=walker.GetFirstChildElement(&element).ok();
            while let Some(current)=child{
                if pending.len()>=256{return Err("focus_tree_limit".into())}
                child=walker.GetNextSiblingElement(&current).ok();pending.push(current);
            }
        }
        Err("unverifiable_input".into())
    }
}
unsafe fn clipboard_snapshot()->Result<Vec<(u32,Vec<u8>)>,String>{
    unsafe{
        let mut items=Vec::new();let mut format=EnumClipboardFormats(0);let mut total=0;
        while format!=0{
            if items.len()>=64||[2,3,9,14].contains(&format){return Err("clipboard_format".into())}
            let handle=GetClipboardData(format);let size=GlobalSize(handle);
            if size==0||size>32*1024*1024||total+size>32*1024*1024{return Err("clipboard_size".into())}
            let ptr=GlobalLock(handle);if ptr.is_null(){return Err("clipboard_lock".into())}
            items.push((format,std::slice::from_raw_parts(ptr as *const u8,size).to_vec()));GlobalUnlock(handle);total+=size;
            format=EnumClipboardFormats(format);
        }
        Ok(items)
    }
}
unsafe fn write_clipboard_unicode(text:&str)->Result<(),String>{
    unsafe{
        let unicode:Vec<u16>=text.encode_utf16().chain(Some(0)).collect();
        let bytes=std::slice::from_raw_parts(unicode.as_ptr()as *const u8,unicode.len()*2);
        let handle=GlobalAlloc(GMEM_MOVEABLE,bytes.len());if handle.is_null(){return Err("clipboard_allocate".into())}
        let ptr=GlobalLock(handle);if ptr.is_null(){GlobalFree(handle);return Err("clipboard_allocate".into())}
        std::ptr::copy_nonoverlapping(bytes.as_ptr(),ptr as *mut u8,bytes.len());GlobalUnlock(handle);
        if EmptyClipboard()==0||SetClipboardData(13,handle).is_null(){GlobalFree(handle);return Err("clipboard_write".into())}
        Ok(())
    }
}
unsafe fn read_clipboard_unicode()->Result<String,String>{
    unsafe{
        let handle=GetClipboardData(13);let size=GlobalSize(handle);
        if handle.is_null()||size<2||size>96_002{return Err("selection_copy_invalid".into())}
        let ptr=GlobalLock(handle)as *const u16;if ptr.is_null(){return Err("selection_copy_invalid".into())}
        let units=std::slice::from_raw_parts(ptr,size/2);let end=units.iter().position(|unit|*unit==0).unwrap_or(units.len());
        let text=String::from_utf16(&units[..end]).map_err(|_|"selection_copy_invalid".to_owned());GlobalUnlock(handle);text
    }
}
unsafe fn restore_clipboard(snapshot:Vec<(u32,Vec<u8>)>,sequence:u32){
    unsafe{
        if GetClipboardSequenceNumber()!=sequence||OpenClipboard(null_mut())==0{return}
        if GetClipboardSequenceNumber()==sequence{
            EmptyClipboard();
            for(format,data)in snapshot{
                let handle=GlobalAlloc(GMEM_MOVEABLE,data.len());if handle.is_null(){continue}
                let ptr=GlobalLock(handle);if ptr.is_null(){GlobalFree(handle);continue}
                std::ptr::copy_nonoverlapping(data.as_ptr(),ptr as *mut u8,data.len());GlobalUnlock(handle);
                if SetClipboardData(format,handle).is_null(){GlobalFree(handle);}
            }
        }
        CloseClipboard();
    }
}
fn copy_selected_text(target:&Target)->Result<String,String>{
    unsafe{
        if OpenClipboard(null_mut())==0{return Err("selection_copy_clipboard".into())}
        let snapshot=match clipboard_snapshot(){Ok(value)=>value,Err(error)=>{CloseClipboard();return Err(format!("selection_copy_{error}"))}};
        let marker=format!("OpenTalk-selection-{}-{}",GetCurrentProcessId(),GetCurrentThreadId());
        if let Err(error)=write_clipboard_unicode(&marker){CloseClipboard();return Err(format!("selection_copy_{error}"))}
        let marker_sequence=GetClipboardSequenceNumber();CloseClipboard();
        let direct=focused_native_edit(target).filter(|window|supports_direct_paste(*window));
        let copied=if let Some(window)=direct{
            let mut result=0usize;if SendMessageTimeoutW(window,WM_COPY,0,0,SMTO_ABORTIFHUNG,500,&mut result)!=0{Ok(())}else{Err("input_acknowledgment".into())}
        }else{send_shortcut(0x43,0x4f544153)};
        if let Err(reason)=copied{if OpenClipboard(null_mut())!=0{let sequence=GetClipboardSequenceNumber();CloseClipboard();restore_clipboard(snapshot,sequence);}return Err(format!("selection_copy_{reason}"))}
        let mut changed=false;
        for _ in 0..30{if GetClipboardSequenceNumber()!=marker_sequence{changed=true;break}thread::sleep(Duration::from_millis(10));}
        if !changed{if OpenClipboard(null_mut())!=0{let sequence=GetClipboardSequenceNumber();CloseClipboard();restore_clipboard(snapshot,sequence);}return Err("selection_copy_timeout".into())}
        if OpenClipboard(null_mut())==0{return Err("selection_copy_clipboard".into())}
        let sequence=GetClipboardSequenceNumber();let text=read_clipboard_unicode();CloseClipboard();restore_clipboard(snapshot,sequence);
        let text=text?;if text==marker||text.trim().is_empty()||text.encode_utf16().count()>=48_001||text.len()>96_000||text.contains('\0'){Err("selection_copy_invalid".into())}else{Ok(text)}
    }
}
unsafe fn integrity(process: HANDLE) -> Result<u32, String> {
    unsafe {
        let mut token = null_mut();
        if OpenProcessToken(process, TOKEN_QUERY, &mut token) == 0 { return Err("integrity".into()); }
        let mut size = 0; GetTokenInformation(token, TokenIntegrityLevel, null_mut(), 0, &mut size);
        if size == 0 || size > 65536 { CloseHandle(token); return Err("integrity".into()); }
        let mut bytes = vec![0u8; size as usize];
        if GetTokenInformation(token, TokenIntegrityLevel, bytes.as_mut_ptr().cast(), size, &mut size) == 0 { CloseHandle(token); return Err("integrity".into()); }
        let label = &*(bytes.as_ptr() as *const TOKEN_MANDATORY_LABEL);
        let count = *GetSidSubAuthorityCount(label.Label.Sid);
        let level = *GetSidSubAuthority(label.Label.Sid, count as u32 - 1);
        CloseHandle(token); Ok(level)
    }
}
fn inspect_expected(expected:Option<&Target>) -> Result<Target, String> {
    unsafe {
        let desktop = OpenInputDesktop(0, 0, DESKTOP_READOBJECTS);
        if desktop.is_null() { return Err("secure_desktop".into()); }
        // The active desktop must be the interactive Default desktop.
        let mut name=[0u16;128]; let mut needed=0;
        let valid=GetUserObjectInformationW(desktop,UOI_NAME,name.as_mut_ptr().cast(),256,&mut needed)!=0;
        CloseDesktop(desktop);
        let end=name.iter().position(|x|*x==0).unwrap_or(name.len());
        if !valid || String::from_utf16_lossy(&name[..end])!="Default" { return Err("secure_desktop".into()); }
        let hwnd=GetForegroundWindow(); if hwnd.is_null() { return Err("focus".into()); }
        let mut process=0; GetWindowThreadProcessId(hwnd,&mut process);
        let handle=OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION,0,process);
        if handle.is_null() { return Err("process".into()); }
        let their=integrity(handle); CloseHandle(handle);
        if their? > integrity(GetCurrentProcess())? { return Err("privileged".into()); }
        let automation=AUTOMATION.with(|slot| -> Result<IUIAutomation,String> {
            let mut cached=slot.borrow_mut();
            if cached.is_none(){*cached=Some(CoCreateInstance(&CUIAutomation,None,CLSCTX_INPROC_SERVER).map_err(|_|"accessibility")?);}
            Ok(cached.as_ref().unwrap().clone())
        })?;
        let candidate=focused_element_with_retry(||automation.GetFocusedElement(),||thread::sleep(Duration::from_millis(25)))?;
        let element=if is_focused_input(&candidate,process){candidate}else if let Some(expected)=expected{find_input_by_runtime(&automation,hwnd,process,&expected.runtime)?}else{find_focused_input(&automation,hwnd,process)?};
        if element.CurrentIsPassword().map_err(|_|"password_unknown")?.as_bool() || !element.CurrentIsEnabled().map_err(|_|"enabled_unknown")?.as_bool() || !element.CurrentHasKeyboardFocus().map_err(|_|"focus_unknown")?.as_bool() { return Err("secure_or_disabled".into()); }
        let kind=element.CurrentControlType().map_err(|_|"control_type")?;
        if kind != UIA_EditControlTypeId && kind != UIA_DocumentControlTypeId { return Err("unverifiable_input".into()); }
        if element.CurrentProcessId().map_err(|_|"element_process")? as u32 != process { return Err("element_process".into()); }
        let runtime=runtime_id(&element)?;
        let native=element.CurrentNativeWindowHandle().map(|handle|handle.0 as usize).unwrap_or(0);
        let mut class=[0u16;128]; let length=GetClassNameW(hwnd,class.as_mut_ptr(),128);
        let class=String::from_utf16_lossy(&class[..length.max(0)as usize]);
        let terminal=class.contains("CASCADIA") || class.contains("ConsoleWindowClass") || class.contains("PseudoConsole");
        Ok(Target { hwnd:hwnd as usize, process, runtime, native, input_generation:INPUT_GENERATION.load(Ordering::Acquire), focus_generation:FOCUS_GENERATION.load(Ordering::Acquire), selection_generation:SELECTION_GENERATION.load(Ordering::Acquire), terminal })
    }
}
pub fn inspect_selection() -> Result<Selection,String> {
    unsafe {
        let target=inspect()?;
        let automation=AUTOMATION.with(|slot|slot.borrow().as_ref().cloned()).ok_or("accessibility")?;
        let candidate=focused_element_with_retry(||automation.GetFocusedElement(),||thread::sleep(Duration::from_millis(25)))?;
        let element=if is_focused_input(&candidate,target.process){candidate}else{find_focused_input(&automation,target.hwnd as HWND,target.process)?};
        let automation_selection=(||->Result<(String,SelectionBounds),String>{
            let pattern:IUIAutomationTextPattern=element.GetCurrentPatternAs(UIA_TextPatternId).map_err(|_|"selection_unsupported")?;
            let ranges=pattern.GetSelection().map_err(|_|"selection_unknown")?;
            if ranges.Length().map_err(|_|"selection_unknown")?!=1{return Err("selection_count".into())}
            let range=ranges.GetElement(0).map_err(|_|"selection_unknown")?;
            let value=range.GetText(48_001).map_err(|_|"selection_text")?.to_string();
            if value.trim().is_empty()||value.encode_utf16().count()>=48_001||value.len()>96_000||value.contains('\0'){return Err("selection_invalid".into())}
            let array=range.GetBoundingRectangles().map_err(|_|"selection_bounds")?;
            let values=(||->Result<Vec<f64>,String>{
                if array.is_null()||SafeArrayGetDim(array)!=1||SafeArrayGetVartype(array).map_err(|_|"selection_bounds")?!=VT_R8{return Err("selection_bounds".into())}
                let lower=SafeArrayGetLBound(array,1).map_err(|_|"selection_bounds")?;
                let upper=SafeArrayGetUBound(array,1).map_err(|_|"selection_bounds")?;
                if upper<lower||upper-lower>4095||(upper-lower+1)%4!=0{return Err("selection_bounds".into())}
                let mut data=null_mut();SafeArrayAccessData(array,&mut data).map_err(|_|"selection_bounds")?;
                let result=std::slice::from_raw_parts(data as *const f64,(upper-lower+1)as usize).to_vec();
                let _=SafeArrayUnaccessData(array);Ok(result)
            })();
            let _=SafeArrayDestroy(array);let values=values?;
            let rectangle=values.chunks_exact(4).last().ok_or("selection_bounds")?;
            if rectangle.iter().any(|value|!value.is_finite())||rectangle[2]<=0.0||rectangle[3]<=0.0{return Err("selection_bounds".into())}
            Ok((value,SelectionBounds{x:rectangle[0].round()as i32,y:rectangle[1].round()as i32,width:rectangle[2].round()as i32,height:rectangle[3].round()as i32}))
        })();
        let(text,bounds)=automation_selection?;
        Ok(Selection{target,text,bounds,capture:SelectionCapture::Automation})
    }
}
pub fn inspect() -> Result<Target, String> { inspect_expected(None) }
fn focused_native_edit(target:&Target)->Option<HWND>{
    unsafe{
        let window=target.hwnd as HWND;
        let native=target.native as HWND;
        if !native.is_null()&&IsWindow(native)!=0&&GetAncestor(native,GA_ROOT)==window{
            let mut process=0;GetWindowThreadProcessId(native,&mut process);
            if process==target.process{return Some(native)}
        }
        let thread_id=GetWindowThreadProcessId(window,null_mut());
        let mut info:GUITHREADINFO=std::mem::zeroed();info.cbSize=size_of::<GUITHREADINFO>()as u32;
        if thread_id!=0&&GetGUIThreadInfo(thread_id,&mut info)!=0&&!info.hwndFocus.is_null()&&GetAncestor(info.hwndFocus,GA_ROOT)==window{
            let mut process=0;GetWindowThreadProcessId(info.hwndFocus,&mut process);
            let mut class=[0u16;128];let length=GetClassNameW(info.hwndFocus,class.as_mut_ptr(),class.len()as i32);
            if process==target.process&&length>0&&String::from_utf16_lossy(&class[..length as usize]).to_ascii_uppercase().contains("EDIT"){return Some(info.hwndFocus)}
        }
        let mut pending=Vec::new();let first=GetWindow(window,GW_CHILD);if !first.is_null(){pending.push(first)}
        let mut found=None;let mut visited=0usize;
        while let Some(candidate)=pending.pop(){
            visited+=1;if visited>256{return None}
            let sibling=GetWindow(candidate,GW_HWNDNEXT);if !sibling.is_null(){pending.push(sibling)}
            let child=GetWindow(candidate,GW_CHILD);if !child.is_null(){pending.push(child)}
            let mut candidate_process=0;GetWindowThreadProcessId(candidate,&mut candidate_process);
            let mut candidate_class=[0u16;128];let candidate_length=GetClassNameW(candidate,candidate_class.as_mut_ptr(),candidate_class.len()as i32);
            if candidate_process==target.process&&IsWindowVisible(candidate)!=0&&IsWindowEnabled(candidate)!=0&&candidate_length>0
                &&String::from_utf16_lossy(&candidate_class[..candidate_length as usize]).to_ascii_uppercase().contains("EDIT"){
                if found.is_some(){return None}found=Some(candidate)
            }
        }
        found
    }
}
fn window_class(window:HWND)->Option<String>{
    unsafe{
        let mut class=[0u16;128];let length=GetClassNameW(window,class.as_mut_ptr(),class.len()as i32);
        (length>0).then(||String::from_utf16_lossy(&class[..length as usize]).to_ascii_uppercase())
    }
}
fn supports_direct_paste_class(class:&str)->bool{
    let class=class.to_ascii_uppercase();
    class=="EDIT"||class.contains("RICHEDIT")||class.contains("WINDOWSFORMS10.EDIT")
}
fn supports_direct_paste(window:HWND)->bool{
    window_class(window).is_some_and(|class|supports_direct_paste_class(&class))
}
fn selected_native_window(selection:&Selection)->Option<HWND>{
    if let Some(window)=focused_native_edit(&selection.target).filter(|window|supports_direct_paste(*window)){return Some(window)}
    unsafe{
        let point=POINT{x:selection.bounds.x.saturating_add(selection.bounds.width/2),y:selection.bounds.y.saturating_add(selection.bounds.height/2)};
        let candidate=WindowFromPoint(point);let root=selection.target.hwnd as HWND;
        if candidate.is_null()||candidate==root||GetAncestor(candidate,GA_ROOT)!=root||IsWindowEnabled(candidate)==0{return None}
        let mut process=0;GetWindowThreadProcessId(candidate,&mut process);
        if process==selection.target.process&&supports_direct_paste(candidate){Some(candidate)}else{None}
    }
}
fn clipboard_restore_delay()->Duration{
    *CLIPBOARD_RESTORE_DELAY.get_or_init(||{
        let milliseconds=std::env::var("OPENTALK_CLIPBOARD_RESTORE_MS").ok().and_then(|value|value.parse::<u64>().ok()).unwrap_or(500).clamp(200,2_000);
        Duration::from_millis(milliseconds)
    })
}
fn insert_validated(target:&Target,text:&str,authorization:&InsertionAuthorization,direct:Option<HWND>,valid:impl Fn()->Result<(),String>,mut on_dispatch:impl FnMut(&str,&str)) -> (String,String) {
    if text.is_empty() || text.len()>192000 || text.contains('\0') { return ("notAttempted".into(),"text_invalid".into()); }
    if !authorization.authorized() { return ("notAttempted".into(),"canceled".into()); }
    if target.terminal { return ("notAttempted".into(),"terminal_adapter_unverified".into()); }
    if let Err(reason)=valid() { return ("notAttempted".into(),reason); }
    unsafe {
        if direct.is_none(){if let Err(reason)=shortcut_preflight(0x56){return("notAttempted".into(),reason)}}
        if OpenClipboard(null_mut())==0 { return ("notAttempted".into(),"clipboard_busy".into()); }
        let snapshot=(|| -> Result<Vec<(u32,Vec<u8>)>,String> {
            let mut items=Vec::new(); let mut format=EnumClipboardFormats(0); let mut total=0;
            while format!=0 {
                if items.len()>=64 || [2,3,9,14].contains(&format) { return Err("clipboard_format".into()); }
                let handle=GetClipboardData(format); let size=GlobalSize(handle);
                if size==0 || size>32*1024*1024 || total+size>32*1024*1024 { return Err("clipboard_size".into()); }
                let ptr=GlobalLock(handle); if ptr.is_null() { return Err("clipboard_lock".into()); }
                items.push((format,std::slice::from_raw_parts(ptr as *const u8,size).to_vec())); GlobalUnlock(handle); total+=size;
                format=EnumClipboardFormats(format);
            }
            Ok(items)
        })();
        let snapshot=match snapshot { Ok(s)=>s,Err(reason)=>{CloseClipboard();return("notAttempted".into(),reason)} };
        if !authorization.authorized() { CloseClipboard(); return ("notAttempted".into(),"canceled".into()); }
        let unicode:Vec<u16>=text.encode_utf16().chain(Some(0)).collect();
        let bytes=std::slice::from_raw_parts(unicode.as_ptr()as *const u8,unicode.len()*2);
        let handle=GlobalAlloc(GMEM_MOVEABLE,bytes.len()); if handle.is_null(){CloseClipboard();return("notAttempted".into(),"clipboard_allocate".into())}
        let ptr=GlobalLock(handle); if ptr.is_null(){GlobalFree(handle);CloseClipboard();return("notAttempted".into(),"clipboard_allocate".into())}
        std::ptr::copy_nonoverlapping(bytes.as_ptr(),ptr as *mut u8,bytes.len()); GlobalUnlock(handle);
        if EmptyClipboard()==0 || SetClipboardData(13,handle).is_null(){GlobalFree(handle);CloseClipboard();return("notAttempted".into(),"clipboard_write".into())}
        let sequence=GetClipboardSequenceNumber(); CloseClipboard();
        // Revalidate after clipboard preparation, directly before the single SendInput call.
        let validation=valid();
        let adapter_stable=direct.is_none_or(|window|IsWindow(window)!=0&&GetAncestor(window,GA_ROOT)==target.hwnd as HWND);
        let allowed=validation.is_ok()&&adapter_stable;
        let committed=allowed && authorization.try_commit();
        let dispatch=if !committed{Err("canceled".into())}else if let Some(window)=direct{
            let mut result=0usize;if SendMessageTimeoutW(window,WM_PASTE,0,0,SMTO_ABORTIFHUNG,500,&mut result)!=0{Ok(())}else{Err("input_acknowledgment".into())}
        }else{send_shortcut(0x56,0x50444943)};
        let outcome=if !allowed {"notAttempted"}else if !committed{"notAttempted"}else if dispatch.is_ok(){"attempted"}else{"uncertain"};
        let reason=if !adapter_stable{"selection_control_changed"}else if !allowed {validation.as_ref().err().map(String::as_str).unwrap_or("target_changed")}else if !committed{"canceled"}else if dispatch.is_ok(){"sent_once"}else{dispatch.as_ref().err().map(String::as_str).unwrap_or("input_acknowledgment")};
        if committed { on_dispatch(outcome,reason); }
        if committed { thread::sleep(clipboard_restore_delay()); }
        if GetClipboardSequenceNumber()==sequence && OpenClipboard(null_mut())!=0 {
            if GetClipboardSequenceNumber()==sequence {
                EmptyClipboard();
                for (format,data) in snapshot {
                    let handle=GlobalAlloc(GMEM_MOVEABLE,data.len()); if handle.is_null(){continue}
                    let ptr=GlobalLock(handle); if ptr.is_null(){GlobalFree(handle);continue}
                    std::ptr::copy_nonoverlapping(data.as_ptr(),ptr as *mut u8,data.len()); GlobalUnlock(handle);
                    if SetClipboardData(format,handle).is_null(){GlobalFree(handle);}
                }
            }
            CloseClipboard();
        }
        (outcome.into(),reason.into())
    }
}
pub fn insert(target:&Target,text:&str,authorization:&InsertionAuthorization,on_dispatch:impl FnMut(&str,&str)) -> (String,String) {
    insert_validated(target,text,authorization,None,||match inspect(){Ok(current)if current==*target=>Ok(()),Ok(_)=>Err("target_changed".into()),Err(_)=>Err("target_unavailable".into())},on_dispatch)
}
#[cfg(test)]
fn same_selection(original:&Selection,current:&Selection)->bool { current.target==original.target&&current.text==original.text }
fn target_change_reason(original:&Target,current:&Target)->Option<&'static str>{
    if current.hwnd!=original.hwnd||current.process!=original.process{return Some("selection_window_changed")}
    if current.runtime!=original.runtime||current.native!=original.native{return Some("selection_control_changed")}
    if current.terminal!=original.terminal{return Some("selection_adapter_changed")}
    None
}
fn target_inspection_reason(error:&str)->&'static str {
    match error {
        "secure_desktop"|"privileged"|"password_unknown"|"secure_or_disabled"=>"selection_security_blocked",
        "focus"|"focus_element"|"focus_unknown"=>"selection_focus_unavailable",
        _=>"selection_unavailable",
    }
}
fn restore_target_focus(original:&Target)->Result<(),String>{
    unsafe{
        let window=original.hwnd as HWND;
        if IsWindow(window)==0{return Err("selection_window_changed".into())}
        let mut process=0;GetWindowThreadProcessId(window,&mut process);
        if process!=original.process{return Err("selection_window_changed".into())}
        if GetForegroundWindow()!=window{
            if SetForegroundWindow(window)==0{return Err("selection_focus_unavailable".into())}
            for _ in 0..5{
                if GetForegroundWindow()==window{break}
                thread::sleep(Duration::from_millis(20));
            }
            if GetForegroundWindow()!=window{return Err("selection_focus_unavailable".into())}
        }
        let automation=AUTOMATION.with(|slot| -> Result<IUIAutomation,String> {
            let mut cached=slot.borrow_mut();
            if cached.is_none(){*cached=Some(CoCreateInstance(&CUIAutomation,None,CLSCTX_INPROC_SERVER).map_err(|_|"accessibility")?);}
            Ok(cached.as_ref().unwrap().clone())
        }).map_err(|error|target_inspection_reason(&error).to_owned())?;
        let element=find_input_by_runtime(&automation,window,process,&original.runtime).map_err(|error|target_inspection_reason(&error).to_owned())?;
        if !element.CurrentHasKeyboardFocus().map_err(|_|"selection_focus_unavailable")?.as_bool(){
            element.SetFocus().map_err(|_|"selection_focus_unavailable")?;
        }
        Ok(())
    }
}
fn current_selection_text(target:&Target)->Result<String,String>{
    unsafe{
        let automation=AUTOMATION.with(|slot|slot.borrow().as_ref().cloned()).ok_or("selection_unavailable")?;
        let element=find_input_by_runtime(&automation,target.hwnd as HWND,target.process,&target.runtime).map_err(|_|"selection_unavailable")?;
        let read=||->Result<String,String>{
            let pattern:IUIAutomationTextPattern=element.GetCurrentPatternAs(UIA_TextPatternId).map_err(|_|"selection_unavailable")?;
            let ranges=pattern.GetSelection().map_err(|_|"selection_unavailable")?;
            if ranges.Length().map_err(|_|"selection_unavailable")?!=1{return Err("selection_range_changed".into())}
            ranges.GetElement(0).map_err(|_|"selection_unavailable".to_owned())?.GetText(48_001).map_err(|_|"selection_unavailable".to_owned()).map(|text|text.to_string())
        };
        match read(){Ok(text)=>Ok(text),Err(_)=>{thread::sleep(Duration::from_millis(25));read()}}
    }
}
fn validate_selection_target(original:&Selection)->Result<(),String>{
    restore_target_focus(&original.target)?;
    let current=inspect_expected(Some(&original.target)).map_err(|error|target_inspection_reason(&error).to_owned())?;
    if let Some(reason)=target_change_reason(&original.target,&current){return Err(reason.into())}
    let selected=match original.capture{SelectionCapture::Automation=>current_selection_text(&original.target)?,SelectionCapture::Clipboard=>copy_selected_text(&original.target)?};
    if selected!=original.text{return Err(if selected.is_empty(){"selection_empty"}else{"selection_text_changed"}.into())}
    Ok(())
}
pub fn replace_selection(selection:&Selection,text:&str,authorization:&InsertionAuthorization,on_dispatch:impl FnMut(&str,&str)) -> (String,String) {
    insert_validated(&selection.target,text,authorization,selected_native_window(selection),||validate_selection_target(selection),on_dispatch)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn invalidation_wins_before_insertion_commitment() {
        let authorization=InsertionAuthorization::new();
        assert!(authorization.invalidate());
        assert!(!authorization.try_commit());
        assert!(!authorization.invalidate());
    }
    #[test]
    fn insertion_commitment_is_single_and_cannot_be_reclassified() {
        let authorization=InsertionAuthorization::new();
        assert!(authorization.try_commit());
        assert!(!authorization.try_commit());
        assert!(!authorization.invalidate());
    }
    #[test]
    fn shortcut_batch_is_balanced_ordered_and_non_destructive(){
        for action in [0x43,0x56] {
            let strokes=shortcut_strokes(action);
            assert_eq!(strokes,[
                ShortcutStroke{key:VK_CONTROL,up:false},ShortcutStroke{key:action,up:false},
                ShortcutStroke{key:action,up:true},ShortcutStroke{key:VK_CONTROL,up:true},
            ]);
            assert!(strokes.iter().all(|stroke|![0x41,VK_BACK,VK_DELETE,VK_RETURN].contains(&stroke.key)));
            assert!(synthetically_owned(&strokes,strokes.len()).is_empty());
        }
    }
    #[test]
    fn partial_shortcut_cleanup_releases_only_synthetic_nonphysical_keys(){
        let strokes=shortcut_strokes(0x56);
        assert_eq!(synthetically_owned(&strokes,0),Vec::<u16>::new());
        assert_eq!(synthetically_owned(&strokes,1),vec![VK_CONTROL]);
        assert_eq!(synthetically_owned(&strokes,2),vec![VK_CONTROL,0x56]);
        assert_eq!(synthetically_owned(&strokes,3),vec![VK_CONTROL]);
        let owned=synthetically_owned(&strokes,2);
        assert_eq!(owned_release_strokes(&owned,|_|false),vec![ShortcutStroke{key:0x56,up:true},ShortcutStroke{key:VK_CONTROL,up:true}]);
        assert_eq!(owned_release_strokes(&owned,|key|key==VK_CONTROL),vec![ShortcutStroke{key:0x56,up:true}]);
        assert_eq!(owned_release_strokes(&owned,|key|key==0x56),vec![ShortcutStroke{key:VK_CONTROL,up:true}]);
    }
    #[test]
    fn injected_events_do_not_change_physical_key_ownership(){
        const TEST_KEY:u16=0x7e;
        record_keyboard_event(TEST_KEY as u32,false,false);
        record_keyboard_event(TEST_KEY as u32,true,true);assert!(!physical_key_down(TEST_KEY));
        record_keyboard_event(TEST_KEY as u32,true,false);assert!(physical_key_down(TEST_KEY));
        record_keyboard_event(TEST_KEY as u32,false,true);assert!(physical_key_down(TEST_KEY));
        record_keyboard_event(TEST_KEY as u32,false,false);assert!(!physical_key_down(TEST_KEY));
    }
    fn fixture_selection(text:&str,input_generation:u64)->Selection {
        Selection { target:Target { hwnd:1,process:2,runtime:vec![3],native:0,input_generation,focus_generation:4,selection_generation:5,terminal:false },text:text.into(),bounds:SelectionBounds{x:10,y:20,width:30,height:12},capture:SelectionCapture::Automation }
    }
    #[test]
    fn selection_revalidation_requires_the_same_text_and_target_fingerprint() {
        let original=fixture_selection("Selected text.",5);
        assert!(same_selection(&original,&original.clone()));
        assert!(!same_selection(&original,&fixture_selection("Different text.",5)));
        assert!(!same_selection(&original,&fixture_selection("Selected text.",6)));
        assert_eq!(target_change_reason(&original.target,&fixture_selection("Different text.",5).target),None);
        assert_eq!(target_change_reason(&original.target,&fixture_selection("Selected text.",6).target),None);
        let mut changed_range=original.target.clone();changed_range.selection_generation+=1;
        assert_eq!(target_change_reason(&original.target,&changed_range),None);
        let mut changed_control=original.target.clone();changed_control.runtime=vec![9];
        assert_eq!(target_change_reason(&original.target,&changed_control),Some("selection_control_changed"));
    }
    #[test]
    fn direct_paste_is_reserved_for_native_edit_controls(){
        assert!(supports_direct_paste_class("Edit"));
        assert!(supports_direct_paste_class("RichEditD2DPT"));
        assert!(supports_direct_paste_class("WindowsForms10.EDIT.app.0.141b42a_r8_ad1"));
        assert!(!supports_direct_paste_class("Chrome_RenderWidgetHostHWND"));
        assert!(!supports_direct_paste_class("_WwG"));
    }
    #[test]
    fn focused_element_lookup_retries_once_after_a_transient_error() {
        let mut attempts=0;let mut pauses=0;
        assert_eq!(focused_element_with_retry(||{attempts+=1;if attempts==1{Err("transient")}else{Ok("focused")}},||pauses+=1),Ok("focused"));
        assert_eq!((attempts,pauses),(2,1));
    }
    #[test]
    fn focused_element_lookup_stays_bounded_when_the_retry_fails() {
        let mut attempts=0;let mut pauses=0;
        assert_eq!(focused_element_with_retry::<(),_>(||{attempts+=1;Err("unavailable")},||pauses+=1),Err("focus_element".into()));
        assert_eq!((attempts,pauses),(2,1));
    }
    #[test]
    #[ignore = "opt-in W23 paste; requires OPENTALK_W23_TARGET=1 and the disposable native edit target"]
    fn controlled_native_edit_replacement() {
        assert_eq!(std::env::var("OPENTALK_W23_TARGET").as_deref(),Ok("1"));
        use windows::Win32::System::Com::{CoInitializeEx,CoUninitialize,COINIT_MULTITHREADED};
        unsafe{CoInitializeEx(None,COINIT_MULTITHREADED).ok().expect("COM initialization");}
        struct ComGuard;impl Drop for ComGuard{fn drop(&mut self){clear_automation();unsafe{CoUninitialize();}}}
        let _com=ComGuard;
        let fixture_window=std::env::var("OPENTALK_W23_TARGET_WINDOW").expect("fixture window").parse::<usize>().expect("fixture window handle") as HWND;
        let fixture_editor=std::env::var("OPENTALK_W23_TARGET_EDITOR").expect("fixture editor").parse::<usize>().expect("fixture editor handle") as HWND;
        assert!(unsafe{IsWindow(fixture_window)}!=0,"fixture window is unavailable");
        assert!(unsafe{IsWindow(fixture_editor)}!=0,"fixture editor is unavailable");
        let mut process=0;unsafe{GetWindowThreadProcessId(fixture_window,&mut process);}
        let target=Target{hwnd:fixture_window as usize,process,runtime:vec![1],native:fixture_editor as usize,input_generation:0,focus_generation:0,selection_generation:0,terminal:false};
        let authorization=InsertionAuthorization::new();let mut dispatched=None;
        let result=insert_validated(&target,"W23 controlled replacement.",&authorization,Some(fixture_editor),||Ok(()),|outcome,reason|dispatched=Some((outcome.to_owned(),reason.to_owned())));
        assert_eq!(result,("attempted".into(),"sent_once".into()));
        assert_eq!(dispatched,Some(result));
    }
}
