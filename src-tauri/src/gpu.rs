//! Which graphics adapter WebView2 renders and decodes video on.
//!
//! Windows gives WebView2's GPU process (msedgewebview2.exe) the power-saving
//! adapter by default, which on a laptop is the integrated one. Chromium's
//! `--use-adapter-luid` switch names the adapter its D3D11 device is created
//! on, and video decode and compositing run on that device. Browser args are
//! fixed when the WebView2 environment starts, so a change applies on restart.

use serde::Serialize;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Adapter {
    pub name: String,
    pub vendor_id: u32,
    /// "high,low" in decimal, the form `--use-adapter-luid` takes. Chromium
    /// parses both halves as decimal; a hex value fails GPU init and the
    /// webview falls back to software rendering.
    pub luid: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GpuInfo {
    /// the setting this launch started with: "auto", "high" or "low"
    pub preference: String,
    /// the adapter passed to WebView2, or None when Windows picks
    pub chosen: Option<Adapter>,
    /// what "high" and "low" resolve to on this machine
    pub high: Option<Adapter>,
    pub low: Option<Adapter>,
}

/// The first hardware adapter DXGI ranks for a preference.
#[cfg(windows)]
fn preferred(pref: windows::Win32::Graphics::Dxgi::DXGI_GPU_PREFERENCE) -> Option<Adapter> {
    use windows::Win32::Graphics::Dxgi::*;
    unsafe {
        let factory: IDXGIFactory6 = CreateDXGIFactory1().ok()?;
        for i in 0.. {
            let adapter: IDXGIAdapter1 = factory.EnumAdapterByGpuPreference(i, pref).ok()?;
            let desc = adapter.GetDesc1().ok()?;
            // skip the Microsoft Basic Render Driver
            if desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32 != 0 {
                continue;
            }
            let end = desc.Description.iter().position(|&c| c == 0).unwrap_or(desc.Description.len());
            return Some(Adapter {
                name: String::from_utf16_lossy(&desc.Description[..end]),
                vendor_id: desc.VendorId,
                luid: format!("{},{}", desc.AdapterLuid.HighPart, desc.AdapterLuid.LowPart),
            });
        }
        None
    }
}

/// Resolve the `gpu` setting. "auto" (or anything unknown) leaves the choice
/// to Windows.
#[cfg(windows)]
pub fn resolve(preference: &str) -> GpuInfo {
    use windows::Win32::Graphics::Dxgi::{DXGI_GPU_PREFERENCE_HIGH_PERFORMANCE, DXGI_GPU_PREFERENCE_MINIMUM_POWER};
    let high = preferred(DXGI_GPU_PREFERENCE_HIGH_PERFORMANCE);
    let low = preferred(DXGI_GPU_PREFERENCE_MINIMUM_POWER);
    let chosen = match preference {
        "high" => high.clone(),
        "low" => low.clone(),
        _ => None,
    };
    GpuInfo { preference: preference.to_string(), chosen, high, low }
}

#[cfg(not(windows))]
pub fn resolve(preference: &str) -> GpuInfo {
    GpuInfo { preference: preference.to_string(), chosen: None, high: None, low: None }
}

/// The browser argument for the chosen adapter, if any.
pub fn browser_arg(info: &GpuInfo) -> Option<String> {
    info.chosen.as_ref().map(|a| format!("--use-adapter-luid={}", a.luid))
}
