//! coomwall's engine: everything that does not need a window.
//!
//! - [`scan`]   walks folders and playlists into a flat list of media entries
//! - [`cache`]  remembers each file's pixel dimensions between runs
//! - [`layout`] the Mosaic solver: slicing-tree layouts and the incremental
//!              operations that keep a running wall still while it changes
//! - [`patch`]  JSON merge patch, so each wall window saves only its own settings

pub mod cache;
pub mod layout;
pub mod patch;
pub mod range;
pub mod scan;
