use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_updater::UpdaterExt;

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

/// Ask the signed update endpoint for a newer version, then install it on
/// request.
///
/// The shell owns this rather than the web bundle: the bundle is built from
/// `../keel`, which has no concept of an installed desktop app, so an update
/// prompt living there could never be shipped. On Windows
/// `download_and_install` launches the NSIS installer and exits the app, so a
/// successful call does not return here.
async fn check_for_update(app: tauri::AppHandle) {
    let update = match app.updater() {
        Ok(updater) => match updater.check().await {
            Ok(Some(update)) => update,
            Ok(None) => {
                println!("[updater] up to date");
                return;
            }
            Err(error) => {
                // Offline or GitHub unreachable is normal; never block startup.
                eprintln!("[updater] check failed: {error}");
                return;
            }
        },
        Err(error) => {
            eprintln!("[updater] unavailable: {error}");
            return;
        }
    };

    let version = update.version.clone();
    let notes = update.body.clone().unwrap_or_default();
    let message = if notes.trim().is_empty() {
        format!("Keel {version} is available.\n\nInstall it now? The app will restart.")
    } else {
        format!(
            "Keel {version} is available.\n\n{}\n\nInstall it now? The app will restart.",
            notes.trim()
        )
    };

    let install = app
        .dialog()
        .message(message)
        .title("Update available")
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Install now".into(),
            "Later".into(),
        ))
        .blocking_show();

    if !install {
        return;
    }

    println!("[updater] downloading {version}");
    if let Err(error) = update
        .download_and_install(|_chunk, _total| {}, || {})
        .await
    {
        eprintln!("[updater] install failed: {error}");
        app.dialog()
            .message(format!("The update could not be installed.\n\n{error}"))
            .title("Update failed")
            .blocking_show();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            // `tauri dev` builds an unbundled binary that cannot install an
            // update, so the check would only ever fail noisily.
            if tauri::is_dev() {
                println!("[updater] skipped in dev");
            } else {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    check_for_update(handle).await;
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![greet])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
