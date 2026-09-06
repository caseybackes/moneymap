#[cfg(any(feature = "production", feature = "sandbox-dev"))]
compile_error!("The rehearsal executable must be built with --no-default-features --features rehearsal.");

#[cfg(not(feature = "rehearsal"))]
compile_error!("The rehearsal executable requires the rehearsal feature.");

#[cfg(feature = "rehearsal")]
mod rehearsal_runtime;

#[cfg(feature = "rehearsal")]
fn main() { rehearsal_runtime::run(); }
