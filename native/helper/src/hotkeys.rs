use std::collections::BTreeSet;

#[derive(Clone, Debug)]
pub struct Chord(pub BTreeSet<u32>);
impl Chord {
    pub fn parse(input: &str) -> Result<Self, String> {
        let mut keys = BTreeSet::new();
        for part in input.split('+') {
            let key = match part {
                "Ctrl" => 0x11, "Alt" => 0x12, "Shift" => 0x10, "Win" => 0x5b, "Space" => 0x20,
                _ if part.len() == 1 && part.as_bytes()[0].is_ascii_uppercase() => part.as_bytes()[0] as u32,
                _ if part.starts_with('F') => 0x6f + part[1..].parse::<u32>().map_err(|_| "shortcut")?,
                _ => return Err("shortcut".into()),
            };
            if !keys.insert(key) { return Err("duplicate_shortcut_key".into()); }
        }
        if keys.len() < 2 || keys.len() > 5 || !(keys.contains(&0x11) || keys.contains(&0x12)) { return Err("shortcut".into()); }
        Ok(Self(keys))
    }
    fn matches(&self, keys: &BTreeSet<u32>) -> bool { self.0 == *keys }
}
pub fn normalize(key: u32) -> u32 { match key { 0xa0 | 0xa1 => 0x10, 0xa2 | 0xa3 => 0x11, 0xa4 | 0xa5 => 0x12, 0x5c => 0x5b, _ => key } }
#[derive(PartialEq, Debug, Clone, Copy)]
pub enum Event { Start, Stop, Cancel, Meeting, SelectionChanged, FocusChanged }
pub struct Matcher {
    pub enabled: bool, pub hold: Chord, pub hands: Chord,
    physical: BTreeSet<u32>, swallowed: BTreeSet<u32>,
    pending_at: Option<u64>, mode: u8, meeting_latched: bool, session_active: bool,
}
impl Default for Matcher {
    fn default() -> Self { Self { enabled: false, hold: Chord::parse("Ctrl+Shift").unwrap(), hands: Chord::parse("Ctrl+Shift+Space").unwrap(), physical: BTreeSet::new(), swallowed: BTreeSet::new(), pending_at: None, mode: 0, meeting_latched: false, session_active: false } }
}
impl Matcher {
    pub fn configure(&mut self, enabled: bool, hold: &str, hands: &str) -> Result<(), String> {
        let h = Chord::parse(hold)?; let f = Chord::parse(hands)?;
        if h.0 == f.0 { return Err("shortcut_conflict".into()); }
        self.enabled = enabled; self.hold = h; self.hands = f; self.pending_at = None;
        if !enabled { self.mode = 0; self.meeting_latched = false; self.session_active = false; }
        Ok(())
    }
    pub fn set_session_active(&mut self, active: bool) { self.session_active=active; if !active {self.mode=0;self.pending_at=None;} }
    pub fn tick(&mut self, now: u64) -> Option<Event> {
        if self.enabled && self.mode == 0 && self.pending_at.is_some_and(|t| now.saturating_sub(t) >= 120) {
            self.pending_at = None; self.mode = 1; return Some(Event::Start);
        }
        None
    }
    pub fn pending_elapsed(&self, now:u64)->u64 { self.pending_at.map_or(0,|at|now.saturating_sub(at)) }
    pub fn key(&mut self, key: u32, down: bool, injected: bool, now: u64) -> (bool, Option<Event>, bool) {
        if injected { return (false, None, false); }
        let physical_key = key; let key = normalize(key);
        let changed = if down { self.physical.insert(physical_key) } else { self.physical.remove(&physical_key) };
        if !changed { return (self.swallowed.contains(&physical_key), None, false); }
        let keys: BTreeSet<u32> = self.physical.iter().map(|k| normalize(*k)).collect();
        let paired = !down && self.swallowed.remove(&physical_key);
        if !self.enabled { return (paired, None, down); }
        if down && key == 0x1b && (self.mode != 0 || self.session_active) { self.mode = 0; self.pending_at = None; self.session_active=false; self.swallowed.insert(physical_key); return (true, Some(Event::Cancel), false); }
        if self.hands.matches(&keys) {
            self.pending_at = None;
            if down { self.swallowed.insert(physical_key); }
            if !self.meeting_latched {
                self.meeting_latched = true;
                // A slow completion may arrive after the hold threshold emitted Start.
                // Clear hold mode so key-up cannot emit Stop; main owns the ordered
                // dictation-release-to-meeting transition.
                self.mode = 0;
                return (true, Some(Event::Meeting), false);
            }
            return (true, None, false);
        }
        self.meeting_latched = false;
        if self.mode == 1 && !self.hold.0.is_subset(&keys) { self.mode = 0; return (paired, Some(Event::Stop), false); }
        if self.hold.matches(&keys) && self.mode == 0 {
            // Never consume hold modifiers. Passing Ctrl/Shift through preserves
            // application shortcuts that extend the prefix, such as Ctrl+Shift+P.
            if down {
                self.pending_at = Some(now);
                let modifier = matches!(key,0x10|0x11|0x12|0x5b);
                if !modifier { self.swallowed.insert(physical_key); }
                return (!modifier, None, false);
            }
            return (paired, None, false);
        }
        if self.pending_at.is_some() && (down || !self.hold.0.is_subset(&keys)) { self.pending_at = None; }
        let related = self.hold.0.contains(&key) || self.hands.0.contains(&key);
        (paired, None, down && !related)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn thirty_hold_cycles() { let mut m = Matcher::default(); m.enabled = true; for i in 0..30 { assert!(!m.key(0xa2,true,false,i*1000).0);assert!(!m.key(0xa0,true,false,i*1000).0); assert_eq!(m.tick(i*1000+120),Some(Event::Start)); assert_eq!(m.tick(i*1000+200),None);let stopped=m.key(0xa0,false,false,i*1000+300);assert!(!stopped.0);assert_eq!(stopped.1,Some(Event::Stop));assert!(!m.key(0xa2,false,false,i*1000+301).0); } }
    #[test] fn meeting_chord_precedes_hold_and_emits_once_per_press() { let mut m=Matcher::default(); m.enabled=true;assert!(!m.key(0x11,true,false,0).0);assert!(!m.key(0x10,true,false,0).0);let meeting=m.key(0x20,true,false,50);assert!(meeting.0);assert_eq!(meeting.1,Some(Event::Meeting)); assert_eq!(m.tick(150),None);assert!(m.key(0x20,true,false,160).0);let space_up=m.key(0x20,false,false,170);assert!(space_up.0);assert_eq!(space_up.1,None);assert_eq!(m.tick(300),None); assert_eq!(m.key(0x20,true,false,310).1,Some(Event::Meeting)); }
    #[test] fn slow_meeting_chord_upgrades_hold_without_a_stop_event() { let mut m=Matcher::default(); m.enabled=true; m.key(0x11,true,false,0); m.key(0x10,true,false,0); assert_eq!(m.tick(120),Some(Event::Start)); assert_eq!(m.key(0x20,true,false,180).1,Some(Event::Meeting)); assert_eq!(m.key(0x20,false,false,200).1,None); assert_eq!(m.key(0x10,false,false,210).1,None); assert_eq!(m.key(0x11,false,false,220).1,None); }
    #[test] fn injected_disabled_and_repeat() { let mut m=Matcher::default(); assert!(!m.key(65,true,false,0).0); m.key(65,false,false,0); m.enabled=true; assert_eq!(m.key(0x11,true,true,0),(false,None,false));assert!(!m.key(0x10,true,false,1).0);assert_eq!(m.tick(200),None);m.key(0x10,false,false,201); m.key(0x11,true,false,210); m.key(0x10,true,false,210); assert!(!m.key(0x10,true,false,215).0); assert_eq!(m.tick(330),Some(Event::Start)); assert_eq!(m.key(0x1b,true,false,340).1,Some(Event::Cancel)); }
    #[test] fn both_control_keys_release_only_on_last() { let mut m=Matcher::default(); m.enabled=true; m.key(0xa2,true,false,0); m.key(0xa3,true,false,0); m.key(0xa0,true,false,0); m.tick(120); assert_eq!(m.key(0xa2,false,false,130).1,None); assert_eq!(m.key(0xa3,false,false,140).1,Some(Event::Stop)); m.key(0xa0,false,false,150); }
    #[test] fn escape_cancels_after_recording_has_stopped() { let mut m=Matcher::default();m.enabled=true;m.set_session_active(true);assert_eq!(m.key(0x1b,true,false,0).1,Some(Event::Cancel));assert!(m.key(0x1b,false,false,1).0);assert_eq!(m.key(0x1b,true,false,2).1,None); }
    #[test] fn recommended_hold_passes_modifiers_and_has_no_windows_key() { let mut m=Matcher::default();m.enabled=true;assert!(!m.hold.0.contains(&0x5b));assert!(!m.hands.0.contains(&0x5b));assert!(!m.key(0xa2,true,false,0).0);assert!(!m.key(0xa0,true,false,10).0);assert_eq!(m.tick(130),Some(Event::Start));let stopped=m.key(0xa0,false,false,200);assert!(!stopped.0);assert_eq!(stopped.1,Some(Event::Stop));assert!(!m.key(0xa2,false,false,210).0); }
    #[test] fn application_shortcut_cancels_pending_hold_without_consuming_keys() { let mut m=Matcher::default();m.enabled=true;assert!(!m.key(0xa2,true,false,0).0);assert!(!m.key(0xa0,true,false,10).0);let p_down=m.key(0x50,true,false,20);assert_eq!(p_down,(false,None,true));assert_eq!(m.tick(200),None);assert!(!m.key(0x50,false,false,210).0);assert!(!m.key(0xa0,false,false,220).0);assert!(!m.key(0xa2,false,false,230).0); }
}
