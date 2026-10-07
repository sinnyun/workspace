//! fm-host binary entry point. All wiring lives in the `fm_host_lib` crate so it
//! can be reasoned about (and the kernel headlessly tested) independently of the
//! executable.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    fm_host_lib::run()
}
