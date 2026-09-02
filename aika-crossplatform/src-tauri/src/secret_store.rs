//! API Key 保险库。
//!
//! 对应 Android 原型的 `data/SecretStore.kt`（那边用 EncryptedSharedPreferences）。
//! 桌面版走 Windows DPAPI：密文绑定当前 Windows 用户账户，不需要用户再记一个主密码。
//!
//! 密钥与业务数据分开存放：这里写 `secrets.json`，聊天记录和记忆在 `aika.db`。

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use tauri::{AppHandle, Manager};

const SECRETS_FILE: &str = "secrets.json";

#[cfg(windows)]
mod platform {
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    pub const AVAILABLE: bool = true;

    fn blob(data: &[u8]) -> CRYPT_INTEGER_BLOB {
        CRYPT_INTEGER_BLOB {
            cbData: data.len() as u32,
            pbData: data.as_ptr() as *mut u8,
        }
    }

    /// 取出 DPAPI 分配的缓冲区并交还给系统，避免泄漏。
    unsafe fn take(output: CRYPT_INTEGER_BLOB) -> Vec<u8> {
        let bytes = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        let _ = LocalFree(Some(HLOCAL(output.pbData as *mut core::ffi::c_void)));
        bytes
    }

    pub fn protect(plain: &[u8]) -> Result<Vec<u8>, String> {
        unsafe {
            let input = blob(plain);
            let mut output = CRYPT_INTEGER_BLOB::default();
            CryptProtectData(
                &input,
                None,
                None,
                None,
                None,
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
            .map_err(|error| format!("DPAPI 加密失败：{error}"))?;
            Ok(take(output))
        }
    }

    pub fn unprotect(cipher: &[u8]) -> Result<Vec<u8>, String> {
        unsafe {
            let input = blob(cipher);
            let mut output = CRYPT_INTEGER_BLOB::default();
            CryptUnprotectData(
                &input,
                None,
                None,
                None,
                None,
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
            .map_err(|error| format!("DPAPI 解密失败：{error}"))?;
            Ok(take(output))
        }
    }
}

#[cfg(not(windows))]
mod platform {
    pub const AVAILABLE: bool = false;

    const UNSUPPORTED: &str = "当前平台还没有接入加密保险库，API Key 不会被保存。";

    pub fn protect(_plain: &[u8]) -> Result<Vec<u8>, String> {
        Err(UNSUPPORTED.to_string())
    }

    pub fn unprotect(_cipher: &[u8]) -> Result<Vec<u8>, String> {
        Err(UNSUPPORTED.to_string())
    }
}

fn secrets_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("找不到应用数据目录：{error}"))?;
    fs::create_dir_all(&dir).map_err(|error| format!("无法创建应用数据目录：{error}"))?;
    Ok(dir.join(SECRETS_FILE))
}

fn read_all(app: &AppHandle) -> Result<BTreeMap<String, String>, String> {
    let path = secrets_path(app)?;
    if !path.exists() {
        return Ok(BTreeMap::new());
    }
    let raw = fs::read_to_string(&path).map_err(|error| format!("无法读取密钥文件：{error}"))?;
    // 文件损坏时不要让应用起不来：当作空保险库，用户重新填一次 Key 即可。
    Ok(serde_json::from_str(&raw).unwrap_or_default())
}

fn write_all(app: &AppHandle, entries: &BTreeMap<String, String>) -> Result<(), String> {
    let path = secrets_path(app)?;
    let raw = serde_json::to_string_pretty(entries)
        .map_err(|error| format!("无法序列化密钥文件：{error}"))?;
    fs::write(&path, raw).map_err(|error| format!("无法写入密钥文件：{error}"))
}

#[tauri::command]
pub fn secret_available() -> bool {
    platform::AVAILABLE
}

#[tauri::command]
pub fn secret_set(app: AppHandle, name: String, value: String) -> Result<(), String> {
    let mut entries = read_all(&app)?;
    if value.is_empty() {
        entries.remove(&name);
    } else {
        entries.insert(name, BASE64.encode(platform::protect(value.as_bytes())?));
    }
    write_all(&app, &entries)
}

#[tauri::command]
pub fn secret_get(app: AppHandle, name: String) -> Result<Option<String>, String> {
    let entries = read_all(&app)?;
    let Some(encoded) = entries.get(&name) else {
        return Ok(None);
    };
    let cipher = BASE64
        .decode(encoded)
        .map_err(|error| format!("密钥文件格式损坏：{error}"))?;
    let plain = platform::unprotect(&cipher)?;
    String::from_utf8(plain)
        .map(Some)
        .map_err(|error| format!("密钥不是有效的 UTF-8：{error}"))
}

#[tauri::command]
pub fn secret_delete(app: AppHandle, name: String) -> Result<(), String> {
    let mut entries = read_all(&app)?;
    entries.remove(&name);
    write_all(&app, &entries)
}

#[cfg(all(test, windows))]
mod tests {
    use super::platform;

    #[test]
    fn dpapi_roundtrip_restores_the_key() {
        let key = "sk-test-1234567890";
        let cipher = platform::protect(key.as_bytes()).expect("protect");
        assert_ne!(cipher, key.as_bytes(), "密文不能等于明文");
        let plain = platform::unprotect(&cipher).expect("unprotect");
        assert_eq!(String::from_utf8(plain).unwrap(), key);
    }

    #[test]
    fn tampered_cipher_is_rejected_instead_of_returning_garbage() {
        let mut cipher = platform::protect(b"sk-test").expect("protect");
        let last = cipher.len() - 1;
        cipher[last] ^= 0xff;
        assert!(platform::unprotect(&cipher).is_err());
    }
}
