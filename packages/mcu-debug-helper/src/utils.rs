use std::path::{Path, PathBuf, Component, Prefix};
use urlencoding::decode;
use std::env;

pub fn canonicalize_path(source_path: &str) -> String {
    let mut path_str = source_path.to_string();

    // 1. Handle file:// URIs
    if path_str.starts_with("file://") {
        let decoded = decode(&path_str[7..]).unwrap_or_else(|_| path_str[7..].into());
        path_str = decoded.into_owned();

        // On Windows, file:///C:/... becomes /C:/... so we need to strip the leading /
        if cfg!(windows) && path_str.starts_with('/') {
            // Check for /C:/ style
            if path_str.chars().nth(2) == Some(':') {
                path_str.remove(0);
            }
        }
    }

    // 2. Handle WSL mount paths (/mnt/c/... -> C:/...)
    if path_str.starts_with("/mnt/") {
        let parts: Vec<&str> = path_str.split('/').collect();
        // Index 0 is empty (before first /), Index 1 is "mnt", Index 2 is the drive
        if parts.len() >= 3 && parts[2].len() == 1 {
            let drive_letter = parts[2].to_uppercase();
            let remaining = parts[3..].join("/");
            path_str = format!("{}:/{}", drive_letter, remaining);
        }
    }

    // 3. Resolve to absolute path
    let path = Path::new(&path_str);
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        env::current_dir().unwrap_or_default().join(path)
    };

    // 4. Use dunce to resolve . and .. and simplify Windows paths (removes \\?\)
    // This requires the 'dunce' crate in Cargo.toml
    let canonical = dunce::canonicalize(&absolute).unwrap_or(absolute);

    // 5. Final Step: Convert to String and FORCE forward slashes
    let mut final_path = canonical.to_string_lossy().replace('\\', "/");

    // Windows Drive Letter Normalization (C:/ not c:/)
    if cfg!(windows) && final_path.chars().nth(1) == Some(':') {
        let drive = final_path.chars().next().unwrap().to_uppercase();
        final_path = format!("{}:{}", drive, &final_path[1..]);
    }

    // UNC Path Normalization (//SERVER/SHARE/path)
    if final_path.starts_with("//") {
        let parts: Vec<String> = final_path[2..]
            .split('/')
            .enumerate()
            .map(|(i, s)| if i < 2 { s.to_uppercase() } else { s.to_string() })
            .collect();
        final_path = format!("//{}", parts.join("/"));
    }

    final_path
}
