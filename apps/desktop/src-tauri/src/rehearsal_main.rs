#[cfg(any(feature = "production", feature = "sandbox-dev"))]
compile_error!("The rehearsal executable must be built with --no-default-features --features rehearsal.");

#[cfg(not(feature = "rehearsal"))]
compile_error!("The rehearsal executable requires the rehearsal feature.");

#[cfg(feature = "rehearsal")]
fn main() {
    // This target deliberately does not import the Money Map library. The library
    // contains Production/Sandbox integration code; rehearsal is introduced as a
    // separate, network-free executable before its fixture runtime is added.
    println!("Money Map Upgrade Rehearsal: fixture runtime is not initialized.");
}
