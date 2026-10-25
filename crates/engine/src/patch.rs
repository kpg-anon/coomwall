//! JSON merge patch (RFC 7396) for settings.json.
//!
//! Each wall window saves only its own part of the settings. Merging that
//! part into the file, rather than writing the window's whole copy, keeps two
//! walls from overwriting each other's changes.

use serde_json::Value;

/// Objects merge key by key, `null` removes a key, anything else replaces.
pub fn merge(target: &mut Value, patch: Value) {
    match patch {
        Value::Object(fields) => {
            if !target.is_object() {
                *target = Value::Object(Default::default());
            }
            let obj = target.as_object_mut().expect("just made an object");
            for (k, v) in fields {
                if v.is_null() {
                    obj.remove(&k);
                } else {
                    merge(obj.entry(k).or_insert(Value::Null), v);
                }
            }
        }
        other => *target = other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn nested_objects_merge_and_other_keys_survive() {
        let mut s = json!({ "rate": 1, "walls": { "A": { "mode": "mosaic", "tiles": 7 }, "B": { "mode": "ribbon" } } });
        merge(&mut s, json!({ "walls": { "A": { "tiles": 9 } } }));
        assert_eq!(s, json!({ "rate": 1, "walls": { "A": { "mode": "mosaic", "tiles": 9 }, "B": { "mode": "ribbon" } } }));
    }

    #[test]
    fn null_removes_and_scalars_replace() {
        let mut s = json!({ "a": 1, "b": { "c": 2 }, "d": [1, 2] });
        merge(&mut s, json!({ "a": null, "b": 3, "d": [9] }));
        assert_eq!(s, json!({ "b": 3, "d": [9] }));
    }

    #[test]
    fn patch_onto_missing_file() {
        let mut s = Value::Null;
        merge(&mut s, json!({ "walls": { "A": { "on": true } } }));
        assert_eq!(s, json!({ "walls": { "A": { "on": true } } }));
    }
}
