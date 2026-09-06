#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(not(any(feature = "production", feature = "sandbox-dev")))]
compile_error!("The desktop executable requires exactly one of production or sandbox-dev.");

#[cfg(any(
    all(feature = "production", feature = "sandbox-dev"),
    feature = "rehearsal"
))]
compile_error!("The desktop executable requires exactly one of production or sandbox-dev; rehearsal uses money-map-rehearsal.");

fn main() {
    money_map_desktop_lib::run()
}
