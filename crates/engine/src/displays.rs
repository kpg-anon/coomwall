//! Which display lies beside another, for Ctrl+Shift+arrow on a wall.
//!
//! Rectangles are in Windows' virtual-screen pixels (physical, so displays at
//! different scale factors still line up edge to edge).

#[derive(Clone, Copy, Debug)]
pub struct Screen {
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Dir {
    Left,
    Right,
    Up,
    Down,
}

impl Dir {
    pub fn parse(s: &str) -> Option<Dir> {
        match s {
            "left" => Some(Dir::Left),
            "right" => Some(Dir::Right),
            "up" => Some(Dir::Up),
            "down" => Some(Dir::Down),
            _ => None,
        }
    }
}

/// Edges within this many pixels count as touching.
const SLACK: i64 = 16;

/// The display on the `dir` side of `screens[from]`: it must start at or past
/// that edge and overlap it across the other axis. Of several, the nearest
/// edge wins, then the one whose centre is closest across.
pub fn neighbor(screens: &[Screen], from: usize, dir: Dir) -> Option<usize> {
    let a = screens.get(from)?;
    let (l, t) = (a.x as i64, a.y as i64);
    let (r, b) = (l + a.w as i64, t + a.h as i64);
    let mut best: Option<(i64, i64, usize)> = None;
    for (i, s) in screens.iter().enumerate() {
        if i == from {
            continue;
        }
        let (sl, st) = (s.x as i64, s.y as i64);
        let (sr, sb) = (sl + s.w as i64, st + s.h as i64);
        let overlap_x = sr.min(r) - sl.max(l);
        let overlap_y = sb.min(b) - st.max(t);
        // distance from our edge to theirs, and centre offset across
        let (gap, across, overlaps) = match dir {
            Dir::Right => (sl - r, (st + sb) - (t + b), overlap_y > 0),
            Dir::Left => (l - sr, (st + sb) - (t + b), overlap_y > 0),
            Dir::Down => (st - b, (sl + sr) - (l + r), overlap_x > 0),
            Dir::Up => (t - sb, (sl + sr) - (l + r), overlap_x > 0),
        };
        if !overlaps || gap < -SLACK {
            continue;
        }
        let key = (gap.max(0), across.abs());
        if best.is_none_or(|(g, c, _)| key < (g, c)) {
            best = Some((key.0, key.1, i));
        }
    }
    best.map(|(_, _, i)| i)
}

#[cfg(test)]
mod tests {
    use super::*;

    // a laptop panel with two monitors side by side above it
    fn panel_and_two_above() -> Vec<Screen> {
        vec![
            Screen { x: 0, y: 0, w: 2560, h: 1440 },
            Screen { x: 5, y: -720, w: 1280, h: 720 },
            Screen { x: 1285, y: -720, w: 1280, h: 720 },
        ]
    }

    #[test]
    fn side_by_side_and_stacked() {
        let s = panel_and_two_above();
        assert_eq!(neighbor(&s, 1, Dir::Right), Some(2));
        assert_eq!(neighbor(&s, 2, Dir::Left), Some(1));
        assert_eq!(neighbor(&s, 1, Dir::Down), Some(0));
        assert_eq!(neighbor(&s, 2, Dir::Down), Some(0));
        // both monitors touch the panel's top edge; the panel's centre (x 1280)
        // is 635 px from monitor 2's (x 645) and 645 px from monitor 3's (x 1925)
        assert_eq!(neighbor(&s, 0, Dir::Up), Some(1));
    }

    #[test]
    fn nothing_that_way() {
        let s = panel_and_two_above();
        assert_eq!(neighbor(&s, 0, Dir::Left), None);
        assert_eq!(neighbor(&s, 0, Dir::Right), None);
        assert_eq!(neighbor(&s, 0, Dir::Down), None);
        assert_eq!(neighbor(&s, 1, Dir::Up), None);
        assert_eq!(neighbor(&s, 2, Dir::Right), None);
        assert_eq!(neighbor(&[Screen { x: 0, y: 0, w: 10, h: 10 }], 0, Dir::Right), None);
    }

    #[test]
    fn a_small_gap_between_displays_still_counts() {
        let s = vec![Screen { x: 0, y: 0, w: 1920, h: 1080 }, Screen { x: 1930, y: 200, w: 1080, h: 1920 }];
        assert_eq!(neighbor(&s, 0, Dir::Right), Some(1));
        assert_eq!(neighbor(&s, 1, Dir::Left), Some(0));
    }
}
