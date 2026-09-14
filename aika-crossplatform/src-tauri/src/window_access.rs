pub const MAIN_WINDOW_LABEL: &str = "main";

pub fn assert_allowed_caller(caller: &str, allowed: &[&str]) -> Result<(), String> {
    if allowed.contains(&caller) { Ok(()) }
    else { Err(format!("window \"{caller}\" is not allowed to call this command")) }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_main_can_capture() {
        assert!(assert_allowed_caller("main", &[MAIN_WINDOW_LABEL]).is_ok());
        assert!(assert_allowed_caller("pet", &[MAIN_WINDOW_LABEL]).is_err());
        assert!(assert_allowed_caller("unknown", &[MAIN_WINDOW_LABEL]).is_err());
    }
}
