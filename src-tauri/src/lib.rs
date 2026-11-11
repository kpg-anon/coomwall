mod commands;
mod gpu;
mod media;
mod walls;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // Media is served through our own scheme rather than the asset
        // protocol: it answers HTTP Range requests from disk in chunks, so
        // seeking a 10 GB video never reads the whole file into memory.
        .register_asynchronous_uri_scheme_protocol(media::SCHEME, |_ctx, request, responder| {
            std::thread::spawn(move || responder.respond(media::serve(&request)));
        })
        .setup(|app| {
            let state = commands::AppState::new(app.handle())?;
            // The window is created here rather than from tauri.conf.json
            // ("create": false) so its browser args can carry the GPU setting.
            let mut cfg = app
                .config()
                .app
                .windows
                .iter()
                .find(|w| w.label == "main")
                .cloned()
                .ok_or("no main window in tauri.conf.json")?;
            let mut args = cfg.additional_browser_args.take().unwrap_or_default();
            if let Some(arg) = gpu::browser_arg(&state.gpu) {
                args.push(' ');
                args.push_str(&arg);
            }
            // Chromium converts every colour to the display's profile. On a
            // wide-gamut panel that sends sRGB red (255, 0, 0) out as about
            // (212, 51, 33), so media looks less saturated than in players
            // that do not colour-manage (mpv, most image viewers). "direct",
            // the default, treats the display as sRGB: values go out as they
            // are in the file.
            if state.color == "direct" {
                args.push_str(" --force-color-profile=srgb");
            }
            // dev only: CW_CDP_PORT=9444 opens a DevTools Protocol port without
            // replacing the args above, as WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS would
            #[cfg(debug_assertions)]
            if let Ok(port) = std::env::var("CW_CDP_PORT") {
                args.push_str(&format!(" --remote-debugging-port={port}"));
            }
            // dev only, for trying browser flags: CW_DISABLE_FEATURES=A,B joins the
            // --disable-features list above (a second such switch would replace it),
            // CW_EXTRA_ARGS is appended as is
            #[cfg(debug_assertions)]
            if let Some(extra) = std::env::var("CW_DISABLE_FEATURES").ok().filter(|v| !v.trim().is_empty()) {
                args = args.replacen("--disable-features=", &format!("--disable-features={extra},"), 1);
            }
            #[cfg(debug_assertions)]
            if let Some(extra) = std::env::var("CW_EXTRA_ARGS").ok().filter(|v| !v.trim().is_empty()) {
                args.push(' ');
                args.push_str(&extra);
            }
            println!("coomwall: browser args: {args}");
            cfg.additional_browser_args = Some(args);
            app.manage(state);
            let data_dir = commands::dev_data_dir().map(|dir| {
                println!("coomwall: data dir: {}", dir.display());
                dir.join("webview")
            });
            let mut window = tauri::WebviewWindowBuilder::from_config(app.handle(), &cfg)?;
            if let Some(dir) = &data_dir {
                window = window.data_directory(dir.clone());
            }
            window.build()?;
            app.manage(walls::Template { config: cfg, data_dir });
            Ok(())
        })
        .on_window_event(walls::on_window_event)
        .invoke_handler(tauri::generate_handler![
            commands::scan_sources,
            commands::remember_dims,
            commands::plan_initial,
            commands::plan_replace,
            commands::plan_insert,
            commands::plan_remove,
            commands::plan_retile,
            commands::plan_reflow,
            commands::plan_center,
            commands::plan_layout,
            commands::get_settings,
            commands::set_settings,
            commands::patch_settings,
            commands::get_hidden,
            commands::hide_item,
            commands::unhide_items,
            commands::gpu_info,
            commands::launch_color,
            commands::restart,
            walls::open_walls,
            walls::close_walls,
            walls::move_wall,
            walls::focus_wall,
        ])
        .run(tauri::generate_context!())
        .expect("error while running coomwall");
}
