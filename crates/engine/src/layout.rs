//! The Mosaic solver.
//!
//! A wall is a slicing tree: every inner node puts its two children side by
//! side (`Row`) or stacks them (`Col`) and stores where the cut falls as a
//! fraction `f` of its own width or height. Every leaf is one tile.
//!
//! Storing the cut, instead of deriving it from the leaves' aspect ratios, is
//! what makes a running wall stable: a subtree can be swapped for a different
//! one and nothing outside its rectangle moves, because no ancestor's cut
//! depends on what is inside it.
//!
//! When a subtree is (re)built for a rectangle its cuts are chosen from the
//! media's natural aspect ratios:
//!
//! ```text
//!   Row: A = a1 + a2              f = a1 / (a1 + a2)
//!   Col: 1/A = 1/a1 + 1/a2        f = a2 / (a1 + a2)
//! ```
//!
//! so a subtree whose natural aspect `A` equals its rectangle's aspect shows
//! every tile uncropped. Otherwise every tile in it is stretched by the same
//! factor `rect / A`, which cover-fit trims away.
//!
//! The operations ([`replace`], [`insert`], [`remove`], [`arrange`]) search
//! over *where* to make a change (the tile alone, its parent, grandparent, ...)
//! and *what* to put there (trees found by dynamic programming), and score
//! every option on four things:
//!
//! - crop:     `(ln stretch / ln 1.25)^2` per tile
//! - spread:   `(ln (largest area / smallest) / ln 2.5)^2`
//! - motion:   how far tiles already on screen would move or resize, weighted
//!             by `stillness`; tiles that just appeared and frozen tiles weigh more
//! - skipping: a small cost per queued item passed over to find a better fit

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::f64::consts::LN_2;

/// A tile drawn this much wider or narrower than its media costs 1.
const STRETCH_UNIT: f64 = 1.25;
/// Largest tile area / smallest of this factor costs 1.
const SPREAD_UNIT: f64 = 2.5;
/// Width of an aspect bucket in ln(aspect). Trees with the same item set
/// whose aspects fall in one bucket are interchangeable for any tree built on
/// top of them, so only the most even one is kept. This keeps the DP small.
/// 0.05 means two trees within ~5% of each other's shape count as one.
const BUCKET: f64 = 0.05;
/// Subtrees narrower or wider than e^2.4 (about 1:11) are never useful on a
/// screen: a column of eight 16:9 tiles is only e^-1.5.
const LN_ASPECT_LIMIT: f64 = 2.4;
const BUCKETS: usize = (2.0 * LN_ASPECT_LIMIT / BUCKET) as usize + 2;
/// Subtrees whose largest tile is this many times the smallest are dropped:
/// they cost more in spread than any crop they could save.
const SPREAD_LIMIT: f64 = 9.0;
/// Largest item set solved exactly (by subset DP, 3^n). Larger sets are
/// solved over aspect classes instead.
pub const LOCAL_MAX: usize = 8;
/// How many of the best-scoring trees per region are scored against the
/// running wall (motion depends on the whole wall, so it is scored after).
const TOP_TREES: usize = 8;
/// Upper bound on the number of (sub-vector, rest) pairs the class DP visits.
const CLASS_BUDGET: usize = 30000;
const MIN_ASPECT: f64 = 0.2;
const MAX_ASPECT: f64 = 5.0;
/// Placeholder leaf ids used while a class tree is being given real items.
const PLACEHOLDER: u32 = 0xF000_0000;

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl Rect {
    pub fn new(x: f64, y: f64, w: f64, h: f64) -> Self {
        Rect { x, y, w, h }
    }
    pub fn aspect(&self) -> f64 {
        self.w / self.h
    }
    pub fn area(&self) -> f64 {
        self.w * self.h
    }
    fn centre(&self) -> (f64, f64) {
        (self.x + self.w / 2.0, self.y + self.h / 2.0)
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "k", rename_all = "lowercase")]
pub enum Tree {
    Leaf { id: u32 },
    /// side by side, equal heights; `f` is the first child's share of the width
    Row { f: f64, a: Box<Tree>, b: Box<Tree> },
    /// stacked, equal widths; `f` is the first child's share of the height
    Col { f: f64, a: Box<Tree>, b: Box<Tree> },
}

fn node(row: bool, f: f64, a: Tree, b: Tree) -> Tree {
    let (a, b) = (Box::new(a), Box::new(b));
    if row {
        Tree::Row { f, a, b }
    } else {
        Tree::Col { f, a, b }
    }
}

impl Tree {
    pub fn ids(&self) -> Vec<u32> {
        let mut out = Vec::new();
        self.collect(&mut out);
        out
    }

    fn collect(&self, out: &mut Vec<u32>) {
        match self {
            Tree::Leaf { id } => out.push(*id),
            Tree::Row { a, b, .. } | Tree::Col { a, b, .. } => {
                a.collect(out);
                b.collect(out);
            }
        }
    }

    pub fn len(&self) -> usize {
        match self {
            Tree::Leaf { .. } => 1,
            Tree::Row { a, b, .. } | Tree::Col { a, b, .. } => a.len() + b.len(),
        }
    }

    pub fn is_empty(&self) -> bool {
        false
    }

    pub fn contains(&self, id: u32) -> bool {
        match self {
            Tree::Leaf { id: own } => *own == id,
            Tree::Row { a, b, .. } | Tree::Col { a, b, .. } => a.contains(id) || b.contains(id),
        }
    }

    /// The path from the root to a leaf: `false` = first child, `true` = second.
    pub fn path_to(&self, id: u32) -> Option<Vec<bool>> {
        match self {
            Tree::Leaf { id: own } => (*own == id).then(Vec::new),
            Tree::Row { a, b, .. } | Tree::Col { a, b, .. } => {
                if let Some(mut p) = a.path_to(id) {
                    p.insert(0, false);
                    Some(p)
                } else if let Some(mut p) = b.path_to(id) {
                    p.insert(0, true);
                    Some(p)
                } else {
                    None
                }
            }
        }
    }

    pub fn at(&self, path: &[bool]) -> &Tree {
        match (path.split_first(), self) {
            (None, _) | (Some(_), Tree::Leaf { .. }) => self,
            (Some((&second, rest)), Tree::Row { a, b, .. } | Tree::Col { a, b, .. }) => {
                if second { b.at(rest) } else { a.at(rest) }
            }
        }
    }

    /// A copy of this tree with the subtree at `path` replaced by `new`.
    pub fn with_subtree(&self, path: &[bool], new: Tree) -> Tree {
        match (path.split_first(), self) {
            (None, _) | (Some(_), Tree::Leaf { .. }) => new,
            (Some((&second, rest)), Tree::Row { f, a, b }) | (Some((&second, rest)), Tree::Col { f, a, b }) => {
                let row = matches!(self, Tree::Row { .. });
                if second {
                    node(row, *f, (**a).clone(), b.with_subtree(rest, new))
                } else {
                    node(row, *f, a.with_subtree(rest, new), (**b).clone())
                }
            }
        }
    }

    /// This tree without one leaf: its sibling takes the parent's place.
    /// None when the tree is that leaf.
    pub fn without(&self, id: u32) -> Option<Tree> {
        match self {
            Tree::Leaf { id: own } => (*own != id).then(|| self.clone()),
            Tree::Row { f, a, b } | Tree::Col { f, a, b } => {
                let row = matches!(self, Tree::Row { .. });
                match (a.without(id), b.without(id)) {
                    (Some(a), Some(b)) => Some(node(row, *f, a, b)),
                    (Some(only), None) | (None, Some(only)) => Some(only),
                    (None, None) => None,
                }
            }
        }
    }

    /// Paths to every node, root first.
    pub fn paths(&self) -> Vec<Vec<bool>> {
        let mut out = Vec::new();
        self.walk(&mut Vec::new(), &mut out);
        out
    }

    fn walk(&self, here: &mut Vec<bool>, out: &mut Vec<Vec<bool>>) {
        out.push(here.clone());
        if let Tree::Row { a, b, .. } | Tree::Col { a, b, .. } = self {
            here.push(false);
            a.walk(here, out);
            here.pop();
            here.push(true);
            b.walk(here, out);
            here.pop();
        }
    }

    /// The aspect this tree would have if every cut followed its media.
    pub fn natural_aspect(&self, media: &HashMap<u32, f64>) -> f64 {
        match self {
            Tree::Leaf { id } => aspect_of(media, *id),
            Tree::Row { a, b, .. } => a.natural_aspect(media) + b.natural_aspect(media),
            Tree::Col { a, b, .. } => 1.0 / (1.0 / a.natural_aspect(media) + 1.0 / b.natural_aspect(media)),
        }
    }

    /// Same structure, cuts recomputed from the media's aspect ratios.
    pub fn refit(&self, media: &HashMap<u32, f64>) -> Tree {
        match self {
            Tree::Leaf { .. } => self.clone(),
            Tree::Row { a, b, .. } => {
                let (na, nb) = (a.natural_aspect(media), b.natural_aspect(media));
                node(true, na / (na + nb), a.refit(media), b.refit(media))
            }
            Tree::Col { a, b, .. } => {
                let (na, nb) = (a.natural_aspect(media), b.natural_aspect(media));
                node(false, nb / (na + nb), a.refit(media), b.refit(media))
            }
        }
    }

    fn relabel(&self, map: &HashMap<u32, u32>) -> Tree {
        match self {
            Tree::Leaf { id } => Tree::Leaf { id: *map.get(id).unwrap_or(id) },
            Tree::Row { f, a, b } => node(true, *f, a.relabel(map), b.relabel(map)),
            Tree::Col { f, a, b } => node(false, *f, a.relabel(map), b.relabel(map)),
        }
    }
}

pub fn clamp_aspect(a: f64) -> f64 {
    if a.is_finite() && a > 0.0 { a.clamp(MIN_ASPECT, MAX_ASPECT) } else { 1.0 }
}

fn aspect_of(media: &HashMap<u32, f64>, id: u32) -> f64 {
    clamp_aspect(media.get(&id).copied().unwrap_or(1.0))
}

/// Round a cut to a whole pixel once, so both sides share the same edge and
/// the leaves cover the rectangle exactly.
fn snap(start: f64, len: f64, f: f64) -> f64 {
    let cut = (start + len * f).round();
    if len >= 2.0 {
        cut.clamp((start + 1.0).ceil(), (start + len - 1.0).floor())
    } else {
        start + len * f
    }
}

fn split(r: Rect, row: bool, f: f64) -> (Rect, Rect) {
    if row {
        let cut = snap(r.x, r.w, f);
        (Rect::new(r.x, r.y, cut - r.x, r.h), Rect::new(cut, r.y, r.x + r.w - cut, r.h))
    } else {
        let cut = snap(r.y, r.h, f);
        (Rect::new(r.x, r.y, r.w, cut - r.y), Rect::new(r.x, cut, r.w, r.y + r.h - cut))
    }
}

/// Every tile's rectangle, in tree order.
pub fn layout(tree: &Tree, bounds: Rect) -> Vec<(u32, Rect)> {
    let mut out = Vec::with_capacity(tree.len());
    layout_into(tree, bounds, &mut out);
    out
}

fn layout_into(tree: &Tree, r: Rect, out: &mut Vec<(u32, Rect)>) {
    match tree {
        Tree::Leaf { id } => out.push((*id, r)),
        Tree::Row { f, a, b } | Tree::Col { f, a, b } => {
            let (ra, rb) = split(r, matches!(tree, Tree::Row { .. }), *f);
            layout_into(a, ra, out);
            layout_into(b, rb, out);
        }
    }
}

/// The rectangle of the subtree at `path`.
pub fn rect_at(tree: &Tree, bounds: Rect, path: &[bool]) -> Rect {
    match (path.split_first(), tree) {
        (None, _) | (Some(_), Tree::Leaf { .. }) => bounds,
        (Some((&second, rest)), Tree::Row { f, a, b } | Tree::Col { f, a, b }) => {
            let (ra, rb) = split(bounds, matches!(tree, Tree::Row { .. }), *f);
            if second { rect_at(b, rb, rest) } else { rect_at(a, ra, rest) }
        }
    }
}

// ---------------------------------------------------------------------------
// Search: dynamic programming over item sets
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug)]
enum Shape {
    Leaf(u32),
    Row(u32, u32),
    Col(u32, u32),
}

/// One tree found by the DP, stored by its children's arena indices.
/// `lo`/`hi` are the smallest and largest leaf's share of its area.
#[derive(Clone, Copy, Debug)]
struct Cand {
    shape: Shape,
    aspect: f64,
    lo: f64,
    hi: f64,
}

impl Cand {
    fn spread(&self) -> f64 {
        self.hi / self.lo
    }
}

#[derive(Default)]
struct Arena {
    nodes: Vec<Cand>,
}

impl Arena {
    fn push(&mut self, c: Cand) -> u32 {
        self.nodes.push(c);
        (self.nodes.len() - 1) as u32
    }

    fn leaf(&mut self, index: u32, aspect: f64) -> u32 {
        self.push(Cand { shape: Shape::Leaf(index), aspect, lo: 1.0, hi: 1.0 })
    }

    fn combine(&self, row: bool, a: u32, b: u32) -> Cand {
        let (ca, cb) = (self.nodes[a as usize], self.nodes[b as usize]);
        let (aspect, fa) = if row {
            let s = ca.aspect + cb.aspect;
            (s, ca.aspect / s)
        } else {
            // stacked at a common width, each child's height is width / aspect
            let s = 1.0 / (1.0 / ca.aspect + 1.0 / cb.aspect);
            (s, s / ca.aspect)
        };
        let fb = 1.0 - fa;
        Cand {
            shape: if row { Shape::Row(a, b) } else { Shape::Col(a, b) },
            aspect,
            lo: (fa * ca.lo).min(fb * cb.lo),
            hi: (fa * ca.hi).max(fb * cb.hi),
        }
    }

    /// Build a [`Tree`] from a candidate, naming leaf `i` with `name(i)`.
    fn tree(&self, idx: u32, name: &mut dyn FnMut(u32) -> u32) -> Tree {
        let c = self.nodes[idx as usize];
        match c.shape {
            Shape::Leaf(i) => Tree::Leaf { id: name(i) },
            Shape::Row(a, b) => {
                let f = self.nodes[a as usize].aspect / c.aspect.max(1e-9);
                let f = f.clamp(0.0, 1.0);
                node(true, f, self.tree(a, name), self.tree(b, name))
            }
            Shape::Col(a, b) => {
                let (aa, ab) = (self.nodes[a as usize].aspect, self.nodes[b as usize].aspect);
                node(false, ab / (aa + ab), self.tree(a, name), self.tree(b, name))
            }
        }
    }
}

/// Best candidate per aspect bucket for one item set.
struct Buckets {
    slots: Vec<Option<Cand>>,
}

impl Buckets {
    fn new() -> Self {
        Buckets { slots: vec![None; BUCKETS] }
    }

    fn keep(&mut self, c: Cand) {
        let ln = c.aspect.ln();
        if ln.abs() > LN_ASPECT_LIMIT || c.spread() > SPREAD_LIMIT {
            return;
        }
        let key = ((ln + LN_ASPECT_LIMIT) / BUCKET).round() as usize;
        let slot = &mut self.slots[key.min(BUCKETS - 1)];
        match slot {
            Some(kept) if kept.spread() <= c.spread() => {}
            _ => *slot = Some(c),
        }
    }

    fn drain_into(self, arena: &mut Arena) -> Vec<u32> {
        self.slots.into_iter().flatten().map(|c| arena.push(c)).collect()
    }
}

/// Every distinct-enough tree over exactly these items (by bitmask DP).
/// Returns the arena and the root candidates.
fn subset_dp(aspects: &[f64]) -> (Arena, Vec<u32>) {
    let n = aspects.len();
    assert!((1..=12).contains(&n), "subset_dp takes 1..=12 items, got {n}");
    let full = (1usize << n) - 1;
    let mut arena = Arena::default();
    let mut table: Vec<Vec<u32>> = vec![Vec::new(); full + 1];
    for (i, &a) in aspects.iter().enumerate() {
        table[1 << i] = vec![arena.leaf(i as u32, a)];
    }
    for mask in 1..=full {
        if mask.count_ones() < 2 {
            continue;
        }
        // Each unordered split once: the half holding the lowest set bit is
        // the first child. Mirror images are found later by `orient`.
        let low = mask & mask.wrapping_neg();
        let rest = mask ^ low;
        let mut best = Buckets::new();
        let mut sub = rest;
        loop {
            let first = sub | low;
            let second = mask ^ first;
            if second != 0 {
                for &a in &table[first] {
                    for &b in &table[second] {
                        best.keep(arena.combine(true, a, b));
                        best.keep(arena.combine(false, a, b));
                    }
                }
            }
            if sub == 0 {
                break;
            }
            sub = (sub - 1) & rest;
        }
        table[mask] = best.drain_into(&mut arena);
    }
    let roots = std::mem::take(&mut table[full]);
    (arena, roots)
}

/// The same DP over aspect classes: items of one class are interchangeable,
/// so the state is a vector of per-class counts instead of a subset.
fn class_dp(aspects: &[f64], counts: &[usize]) -> (Arena, Vec<u32>) {
    let k = counts.len();
    let mut strides = vec![1usize; k];
    for c in 1..k {
        strides[c] = strides[c - 1] * (counts[c - 1] + 1);
    }
    let total = strides[k - 1] * (counts[k - 1] + 1);
    let mut arena = Arena::default();
    let mut table: Vec<Vec<u32>> = vec![Vec::new(); total];
    for c in 0..k {
        if counts[c] > 0 {
            table[strides[c]] = vec![arena.leaf(c as u32, aspects[c])];
        }
    }
    let decode = |mut idx: usize| -> Vec<usize> {
        (0..k)
            .map(|c| {
                let v = idx % (counts[c] + 1);
                idx /= counts[c] + 1;
                v
            })
            .collect()
    };
    for idx in 1..total {
        let v = decode(idx);
        if v.iter().sum::<usize>() < 2 {
            continue;
        }
        let mut best = Buckets::new();
        let mut u = vec![0usize; k];
        loop {
            // odometer over every u <= v
            let mut c = 0;
            while c < k {
                if u[c] < v[c] {
                    u[c] += 1;
                    break;
                }
                u[c] = 0;
                c += 1;
            }
            if c == k {
                break;
            }
            let iu: usize = (0..k).map(|c| u[c] * strides[c]).sum();
            let iw = idx - iu;
            if iu == idx || iu > iw {
                continue;
            }
            for &a in &table[iu] {
                for &b in &table[iw] {
                    best.keep(arena.combine(true, a, b));
                    best.keep(arena.combine(false, a, b));
                }
            }
        }
        table[idx] = best.drain_into(&mut arena);
    }
    let roots = std::mem::take(&mut table[total - 1]);
    (arena, roots)
}

/// Optimal 1-D k-means of sorted values (exact, by DP over split points).
/// Returns each input's class and the classes' means.
fn cluster(values: &[f64], k: usize) -> (Vec<usize>, Vec<f64>) {
    let n = values.len();
    let k = k.clamp(1, n.max(1));
    let mut order: Vec<usize> = (0..n).collect();
    order.sort_by(|&a, &b| values[a].total_cmp(&values[b]));
    let sorted: Vec<f64> = order.iter().map(|&i| values[i]).collect();
    let mut pre = vec![0.0; n + 1];
    let mut pre2 = vec![0.0; n + 1];
    for i in 0..n {
        pre[i + 1] = pre[i] + sorted[i];
        pre2[i + 1] = pre2[i] + sorted[i] * sorted[i];
    }
    let sse = |i: usize, j: usize| {
        // values sorted[i..j]
        let m = (j - i) as f64;
        let s = pre[j] - pre[i];
        (pre2[j] - pre2[i]) - s * s / m
    };
    let inf = f64::INFINITY;
    let mut dp = vec![vec![inf; n + 1]; k + 1];
    let mut cut = vec![vec![0usize; n + 1]; k + 1];
    dp[0][0] = 0.0;
    for c in 1..=k {
        for j in c..=n {
            for i in (c - 1)..j {
                let v = dp[c - 1][i] + sse(i, j);
                if v < dp[c][j] {
                    dp[c][j] = v;
                    cut[c][j] = i;
                }
            }
        }
    }
    let mut bounds = vec![n];
    let mut j = n;
    for c in (1..=k).rev() {
        j = cut[c][j];
        bounds.push(j);
    }
    bounds.reverse();
    let mut class = vec![0usize; n];
    let mut means = Vec::with_capacity(k);
    for c in 0..k {
        let (i, j) = (bounds[c], bounds[c + 1]);
        means.push((pre[j] - pre[i]) / (j - i) as f64);
        for &orig in &order[i..j] {
            class[orig] = c;
        }
    }
    (class, means)
}

fn pair_budget(counts: &[usize]) -> usize {
    counts.iter().map(|&n| (n + 1) * (n + 2) / 2).product()
}

fn crop_term(stretch: f64) -> f64 {
    (stretch.ln() / STRETCH_UNIT.ln()).powi(2)
}

fn spread_term(spread: f64) -> f64 {
    (spread.ln() / SPREAD_UNIT.ln()).powi(2)
}

fn top_roots(arena: &Arena, roots: &[u32], target: f64) -> Vec<u32> {
    let mut ranked: Vec<(f64, u32)> = roots
        .iter()
        .map(|&r| {
            let c = arena.nodes[r as usize];
            (crop_term(target / c.aspect) + spread_term(c.spread()), r)
        })
        .collect();
    ranked.sort_by(|a, b| a.0.total_cmp(&b.0));
    ranked.into_iter().take(TOP_TREES).map(|(_, r)| r).collect()
}

/// The best few trees that put `items` into `rect`, each already turned so
/// tiles in `prev` move as little as possible.
fn solve_trees(items: &[(u32, f64)], rect: Rect, prev: &HashMap<u32, Rect>) -> Vec<Tree> {
    let target = rect.aspect();
    if items.is_empty() {
        return Vec::new();
    }
    if items.len() == 1 {
        return vec![Tree::Leaf { id: items[0].0 }];
    }
    let trees: Vec<Tree> = if items.len() <= LOCAL_MAX {
        let aspects: Vec<f64> = items.iter().map(|&(_, a)| clamp_aspect(a)).collect();
        let (arena, roots) = subset_dp(&aspects);
        top_roots(&arena, &roots, target)
            .into_iter()
            .map(|r| arena.tree(r, &mut |i| items[i as usize].0))
            .collect()
    } else {
        class_trees(items, rect, prev)
    };
    trees.into_iter().map(|t| orient(&t, rect, prev).0).collect()
}

fn class_trees(items: &[(u32, f64)], rect: Rect, prev: &HashMap<u32, Rect>) -> Vec<Tree> {
    let lns: Vec<f64> = items.iter().map(|&(_, a)| clamp_aspect(a).ln()).collect();
    let mut distinct = lns.clone();
    distinct.sort_by(f64::total_cmp);
    distinct.dedup_by(|a, b| (*a - *b).abs() < 0.03);
    let mut k = distinct.len().clamp(1, 6);
    let (class, means) = loop {
        let (class, means) = cluster(&lns, k);
        let mut counts = vec![0usize; means.len()];
        for &c in &class {
            counts[c] += 1;
        }
        if k == 1 || pair_budget(&counts) <= CLASS_BUDGET {
            break (class, means);
        }
        k -= 1;
    };
    let mut counts = vec![0usize; means.len()];
    for &c in &class {
        counts[c] += 1;
    }
    let reps: Vec<f64> = means.iter().map(|m| m.exp()).collect();
    let (arena, roots) = class_dp(&reps, &counts);
    let mut out = Vec::new();
    for root in top_roots(&arena, &roots, rect.aspect()) {
        // Name every leaf with a placeholder that remembers its class ...
        let mut slot_class: HashMap<u32, usize> = HashMap::new();
        let mut next = PLACEHOLDER;
        let draft = arena.tree(root, &mut |c| {
            next += 1;
            slot_class.insert(next, c as usize);
            next
        });
        // ... then give each class's slots to that class's items, nearest
        // (to where they were before) first.
        let slots = layout(&draft, rect);
        let mut map: HashMap<u32, u32> = HashMap::new();
        for c in 0..means.len() {
            let class_slots: Vec<(u32, Rect)> =
                slots.iter().filter(|(s, _)| slot_class[s] == c).copied().collect();
            let class_items: Vec<u32> =
                items.iter().zip(&class).filter(|(_, ic)| **ic == c).map(|(&(id, _), _)| id).collect();
            for (slot, item) in nearest_match(&class_slots, &class_items, prev) {
                map.insert(slot, item);
            }
        }
        out.push(draft.relabel(&map));
    }
    out
}

/// Pair slots with items so items that were on screen land near where they
/// were. Greedy on distance; for at most a few dozen tiles it is close to the
/// best matching.
fn nearest_match(slots: &[(u32, Rect)], items: &[u32], prev: &HashMap<u32, Rect>) -> Vec<(u32, u32)> {
    let mut pairs = Vec::new();
    for (si, (_, r)) in slots.iter().enumerate() {
        for (ii, id) in items.iter().enumerate() {
            if let Some(p) = prev.get(id) {
                let (a, b) = (p.centre(), r.centre());
                pairs.push((((a.0 - b.0).powi(2) + (a.1 - b.1).powi(2)).sqrt(), si, ii));
            }
        }
    }
    pairs.sort_by(|a, b| a.0.total_cmp(&b.0));
    let (mut slot_used, mut item_used) = (vec![false; slots.len()], vec![false; items.len()]);
    let mut out = Vec::new();
    for (_, si, ii) in pairs {
        if !slot_used[si] && !item_used[ii] {
            slot_used[si] = true;
            item_used[ii] = true;
            out.push((slots[si].0, items[ii]));
        }
    }
    let mut free_items = (0..items.len()).filter(|&i| !item_used[i]);
    for (si, used) in slot_used.iter().enumerate() {
        if !used {
            if let Some(ii) = free_items.next() {
                out.push((slots[si].0, items[ii]));
            }
        }
    }
    out
}

/// How much a tile visibly changes going from `a` to `b`, in "tile sizes":
/// a move by its own width is about 1, so is doubling its area. Any change at
/// all costs a little, so one larger move beats many tiny ones.
fn movement(a: &Rect, b: &Rect) -> f64 {
    let (ac, bc) = (a.centre(), b.centre());
    let shift = ((ac.0 - bc.0).powi(2) + (ac.1 - bc.1).powi(2)).sqrt() / a.area().sqrt().max(1.0);
    let size = (b.area() / a.area()).ln().abs() / LN_2;
    let shape = (b.aspect() / a.aspect()).ln().abs() / LN_2 * 0.5;
    if shift < 2e-3 && size < 2e-3 && shape < 2e-3 {
        0.0
    } else {
        0.25 + shift + size + shape
    }
}

/// Choose, at every cut, which child goes first so that tiles already on
/// screen move as little as possible. Exact: a child's cost depends only on
/// the rectangle it gets, so both orders are tried at every node.
fn orient(t: &Tree, r: Rect, prev: &HashMap<u32, Rect>) -> (Tree, f64) {
    match t {
        Tree::Leaf { id } => (t.clone(), prev.get(id).map_or(0.0, |p| movement(p, &r))),
        Tree::Row { f, a, b } | Tree::Col { f, a, b } => {
            if !t.ids().iter().any(|id| prev.contains_key(id)) {
                return (t.clone(), 0.0);
            }
            let row = matches!(t, Tree::Row { .. });
            let (r1, r2) = split(r, row, *f);
            let (ta, ca) = orient(a, r1, prev);
            let (tb, cb) = orient(b, r2, prev);
            let (s1, s2) = split(r, row, 1.0 - f);
            let (tb2, cb2) = orient(b, s1, prev);
            let (ta2, ca2) = orient(a, s2, prev);
            if ca + cb <= ca2 + cb2 + 1e-9 {
                (node(row, *f, ta, tb), ca + cb)
            } else {
                (node(row, 1.0 - f, tb2, ta2), ca2 + cb2)
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Operations on a running wall
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Params {
    /// Weight of motion against crop and spread. 0 = rearrange freely.
    pub stillness: f64,
    /// Largest fraction of any tile's media that may be cropped away.
    pub max_crop: f64,
    /// Tiles that must not move (pinned, or under the pointer).
    pub frozen: Vec<u32>,
    /// Tiles that just changed or just moved; moving them again soon costs 3x.
    pub fresh: Vec<u32>,
    /// Only replace the tile in place: it is being looked at, or the wall
    /// moved a moment ago.
    pub in_place_only: bool,
    /// Whether a whole-wall re-layout may be used when no block near the tile
    /// can take a candidate within the crop limit. The frontend allows it at
    /// most once a minute; a crop past the limit is easier to watch than
    /// every tile moving.
    pub allow_global: bool,
    /// Cost per queued item passed over in favour of a better-fitting one.
    pub skip_cost: f64,
}

impl Default for Params {
    fn default() -> Self {
        Params {
            stillness: 1.2,
            max_crop: 0.3,
            frozen: Vec::new(),
            fresh: Vec::new(),
            in_place_only: false,
            allow_global: true,
            skip_cost: 0.12,
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PlanKind {
    /// only the changed tile's content changed
    Swap,
    /// one block of the wall was laid out again
    Region,
    /// the whole wall was laid out again
    Global,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Placed {
    pub id: u32,
    pub rect: Rect,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub tree: Tree,
    pub rects: Vec<Placed>,
    pub kind: PlanKind,
    /// which candidate was used (index into the candidates passed in)
    pub choice: usize,
    /// the block that changed
    pub region: Option<Rect>,
    pub cost: f64,
    /// how many tiles already on screen move or resize
    pub moved: usize,
    /// the largest fraction of any tile's media cropped away
    pub worst_crop: f64,
}

struct Eval {
    cost: f64,
    rects: Vec<(u32, Rect)>,
    moved: usize,
    worst: f64,
}

fn evaluate(
    tree: &Tree,
    bounds: Rect,
    prev: &HashMap<u32, Rect>,
    media: &HashMap<u32, f64>,
    p: &Params,
    exempt: Option<u32>,
) -> Eval {
    let rects = layout(tree, bounds);
    let frozen: HashSet<u32> = p.frozen.iter().copied().collect();
    let fresh: HashSet<u32> = p.fresh.iter().copied().collect();
    let (mut crop, mut worst, mut motion, mut moved) = (0.0, 0.0f64, 0.0, 0usize);
    let (mut lo, mut hi) = (f64::INFINITY, 0.0f64);
    for (id, r) in &rects {
        let stretch = r.aspect() / aspect_of(media, *id);
        crop += crop_term(stretch);
        worst = worst.max(1.0 - (-stretch.ln().abs()).exp());
        lo = lo.min(r.area());
        hi = hi.max(r.area());
        if Some(*id) == exempt {
            continue;
        }
        if let Some(before) = prev.get(id) {
            let m = movement(before, r);
            if m > 0.0 {
                moved += 1;
                let weight = if frozen.contains(id) {
                    12.0
                } else if fresh.contains(id) {
                    3.0
                } else {
                    1.0
                };
                motion += weight * m;
            }
        }
    }
    let mut cost = crop + spread_term(hi / lo.max(1.0)) + p.stillness * motion;
    if worst > p.max_crop {
        cost += 100.0 + 1000.0 * (worst - p.max_crop);
    }
    Eval { cost, rects, moved, worst }
}

fn placed(rects: Vec<(u32, Rect)>) -> Vec<Placed> {
    rects.into_iter().map(|(id, rect)| Placed { id, rect }).collect()
}

fn kind_for(path: &[bool], full_depth: usize) -> PlanKind {
    if path.len() == full_depth {
        PlanKind::Swap
    } else if path.is_empty() {
        PlanKind::Global
    } else {
        PlanKind::Region
    }
}

/// Lay out `items` from scratch (first start, or "retile"). Tiles in `prev`
/// are kept near where they were when that costs little.
pub fn arrange(items: &[(u32, f64)], bounds: Rect, prev: &HashMap<u32, Rect>, p: &Params) -> Option<Plan> {
    let media: HashMap<u32, f64> = items.iter().copied().collect();
    let mut best: Option<Plan> = None;
    for tree in solve_trees(items, bounds, prev) {
        let e = evaluate(&tree, bounds, prev, &media, p, None);
        if best.as_ref().map_or(true, |b| e.cost < b.cost) {
            best = Some(Plan {
                tree,
                rects: placed(e.rects),
                kind: PlanKind::Global,
                choice: 0,
                region: Some(bounds),
                cost: e.cost,
                moved: e.moved,
                worst_crop: e.worst,
            });
        }
    }
    best
}

/// Tile `leaf` has finished: put one of `candidates` (aspect ratios, in queue
/// order) on the wall in its place, changing as little as possible.
///
/// Tries, for every candidate, the leaf alone (content swap, nothing moves)
/// and then each ancestor block up to [`LOCAL_MAX`] tiles, re-solved for that
/// block's fixed rectangle so nothing outside the block moves. Blocks holding
/// a frozen tile are never re-solved.
pub fn replace(
    tree: &Tree,
    bounds: Rect,
    leaf: u32,
    media: &HashMap<u32, f64>,
    candidates: &[f64],
    p: &Params,
) -> Option<Plan> {
    let path = tree.path_to(leaf)?;
    let prev: HashMap<u32, Rect> = layout(tree, bounds).into_iter().collect();
    let frozen: HashSet<u32> = p.frozen.iter().copied().filter(|&id| id != leaf).collect();
    let mut best: Option<Plan> = None;
    for (choice, &aspect) in candidates.iter().enumerate() {
        let mut media2 = media.clone();
        media2.insert(leaf, clamp_aspect(aspect));
        let skip = p.skip_cost * choice as f64;
        for depth in (0..=path.len()).rev() {
            let prefix = &path[..depth];
            let sub = tree.at(prefix);
            let block = depth < path.len();
            // the root is a block too on small walls; re-solving it moves
            // every tile, so it is held to the same limit as the fallback
            let whole = prefix.is_empty() && !p.allow_global;
            if block && (p.in_place_only || whole || sub.len() > LOCAL_MAX || sub.ids().iter().any(|id| frozen.contains(id))) {
                break;
            }
            let rect = rect_at(tree, bounds, prefix);
            let options = if block {
                let items: Vec<(u32, f64)> = sub.ids().iter().map(|&id| (id, aspect_of(&media2, id))).collect();
                let mut v = vec![orient(&sub.refit(&media2), rect, &prev).0];
                v.extend(solve_trees(&items, rect, &prev));
                v
            } else {
                vec![sub.clone()]
            };
            for option in options {
                let candidate = tree.with_subtree(prefix, option);
                let e = evaluate(&candidate, bounds, &prev, &media2, p, Some(leaf));
                let cost = e.cost + skip;
                if best.as_ref().map_or(true, |b| cost < b.cost) {
                    best = Some(Plan {
                        tree: candidate,
                        rects: placed(e.rects),
                        kind: kind_for(prefix, path.len()),
                        choice,
                        region: Some(rect),
                        cost,
                        moved: e.moved,
                        worst_crop: e.worst,
                    });
                }
            }
        }
    }
    // No block near the tile can take any candidate within the crop limit:
    // lay the whole wall out again around the best-fitting candidate. Motion
    // still counts, so tiles stay as close to where they were as the new
    // layout allows. Not while the tile is being looked at, when a tile is
    // pinned, or when the caller has not allowed it.
    if best.as_ref().is_some_and(|b| b.worst_crop > p.max_crop) && p.allow_global && !p.in_place_only && frozen.is_empty() {
        let aspect = candidates.first().copied().unwrap_or(1.0);
        let mut media2 = media.clone();
        media2.insert(leaf, clamp_aspect(aspect));
        let items: Vec<(u32, f64)> = tree.ids().iter().map(|&id| (id, aspect_of(&media2, id))).collect();
        if let Some(global) = arrange(&items, bounds, &prev, p) {
            let e = evaluate(&global.tree, bounds, &prev, &media2, p, Some(leaf));
            if best.as_ref().map_or(true, |b| e.cost < b.cost) {
                best = Some(Plan { cost: e.cost, moved: e.moved, worst_crop: e.worst, rects: placed(e.rects), ..global });
            }
        }
    }
    best
}

/// Add one tile. Every block of the wall (a single tile up to [`LOCAL_MAX`]
/// tiles) is tried as the place to make room, and the cheapest wins.
pub fn insert(
    tree: Option<&Tree>,
    bounds: Rect,
    new_id: u32,
    aspect: f64,
    media: &HashMap<u32, f64>,
    p: &Params,
) -> Option<Plan> {
    let mut media2 = media.clone();
    media2.insert(new_id, clamp_aspect(aspect));
    let Some(tree) = tree else {
        return arrange(&[(new_id, clamp_aspect(aspect))], bounds, &HashMap::new(), p);
    };
    let prev: HashMap<u32, Rect> = layout(tree, bounds).into_iter().collect();
    let frozen: HashSet<u32> = p.frozen.iter().copied().collect();
    let mut best: Option<Plan> = None;
    for path in tree.paths() {
        let sub = tree.at(&path);
        let ids = sub.ids();
        if ids.len() + 1 > LOCAL_MAX && !path.is_empty() {
            continue;
        }
        if ids.iter().any(|id| frozen.contains(id)) {
            continue;
        }
        let rect = rect_at(tree, bounds, &path);
        let mut items: Vec<(u32, f64)> = ids.iter().map(|&id| (id, aspect_of(&media2, id))).collect();
        items.push((new_id, aspect_of(&media2, new_id)));
        for option in solve_trees(&items, rect, &prev) {
            let candidate = tree.with_subtree(&path, option);
            let e = evaluate(&candidate, bounds, &prev, &media2, p, None);
            if best.as_ref().map_or(true, |b| e.cost < b.cost) {
                best = Some(Plan {
                    tree: candidate,
                    rects: placed(e.rects),
                    kind: if path.is_empty() { PlanKind::Global } else { PlanKind::Region },
                    choice: 0,
                    region: Some(rect),
                    cost: e.cost,
                    moved: e.moved,
                    worst_crop: e.worst,
                });
            }
        }
    }
    best.or_else(|| {
        // every block holds a frozen tile: lay out everything again
        let mut items: Vec<(u32, f64)> = tree.ids().iter().map(|&id| (id, aspect_of(&media2, id))).collect();
        items.push((new_id, aspect_of(&media2, new_id)));
        arrange(&items, bounds, &prev, p)
    })
}

/// Take one tile off the wall: `leaf`, or (None) whichever unfrozen tile can
/// go with the least disturbance.
pub fn remove(
    tree: &Tree,
    bounds: Rect,
    leaf: Option<u32>,
    media: &HashMap<u32, f64>,
    p: &Params,
) -> Option<Plan> {
    let frozen: HashSet<u32> = p.frozen.iter().copied().collect();
    let leaves: Vec<u32> = match leaf {
        Some(id) => vec![id],
        None => {
            let free: Vec<u32> = tree.ids().into_iter().filter(|id| !frozen.contains(id)).collect();
            if free.is_empty() { tree.ids() } else { free }
        }
    };
    let prev: HashMap<u32, Rect> = layout(tree, bounds).into_iter().collect();
    let mut best: Option<Plan> = None;
    for leaf in leaves {
        let Some(path) = tree.path_to(leaf) else { continue };
        if path.is_empty() {
            continue;
        }
        let others: HashSet<u32> = frozen.iter().copied().filter(|&id| id != leaf).collect();
        for depth in (0..path.len()).rev() {
            let prefix = &path[..depth];
            let sub = tree.at(prefix);
            let parent = depth == path.len() - 1;
            if !parent && (sub.len() - 1 > LOCAL_MAX || sub.ids().iter().any(|id| others.contains(id))) {
                break;
            }
            let Some(rest) = sub.without(leaf) else { continue };
            let rect = rect_at(tree, bounds, prefix);
            let items: Vec<(u32, f64)> = rest.ids().iter().map(|&id| (id, aspect_of(media, id))).collect();
            let mut options = vec![rest.clone(), orient(&rest.refit(media), rect, &prev).0];
            if items.len() <= LOCAL_MAX {
                options.extend(solve_trees(&items, rect, &prev));
            }
            for option in options {
                let candidate = tree.with_subtree(prefix, option);
                let e = evaluate(&candidate, bounds, &prev, media, p, None);
                if best.as_ref().map_or(true, |b| e.cost < b.cost) {
                    best = Some(Plan {
                        tree: candidate,
                        rects: placed(e.rects),
                        kind: if prefix.is_empty() { PlanKind::Global } else { PlanKind::Region },
                        choice: 0,
                        region: Some(rect),
                        cost: e.cost,
                        moved: e.moved,
                        worst_crop: e.worst,
                    });
                }
            }
        }
    }
    best
}

/// Lay the whole wall out again, keeping tiles near where they are.
pub fn retile(tree: &Tree, bounds: Rect, media: &HashMap<u32, f64>, p: &Params) -> Option<Plan> {
    let prev: HashMap<u32, Rect> = layout(tree, bounds).into_iter().collect();
    let items: Vec<(u32, f64)> = tree.ids().iter().map(|&id| (id, aspect_of(media, id))).collect();
    // A retile is asked for, so motion is cheap here, but not free: among
    // equally good layouts the one closest to the current wall wins.
    let calm = Params { stillness: p.stillness.min(0.15), frozen: Vec::new(), ..p.clone() };
    arrange(&items, bounds, &prev, &calm)
}

/// Dynamic mode: put a new item (`aspect`) in tile `leaf` and lay the whole
/// wall out again for the new set of shapes. `p.stillness` should be low, so
/// the wall rearranges, but not zero, so among equally good layouts tiles
/// travel the shortest way. The new tile's own move costs nothing: its
/// content is new anyway.
pub fn reflow(tree: &Tree, bounds: Rect, leaf: u32, aspect: f64, media: &HashMap<u32, f64>, p: &Params) -> Option<Plan> {
    if !tree.contains(leaf) {
        return None;
    }
    let mut prev: HashMap<u32, Rect> = layout(tree, bounds).into_iter().collect();
    prev.remove(&leaf);
    let mut media2 = media.clone();
    media2.insert(leaf, clamp_aspect(aspect));
    let items: Vec<(u32, f64)> = tree.ids().iter().map(|&id| (id, aspect_of(&media2, id))).collect();
    arrange(&items, bounds, &prev, p)
}

// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    /// xorshift64*: deterministic, no dependency
    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> f64 {
            self.0 ^= self.0 >> 12;
            self.0 ^= self.0 << 25;
            self.0 ^= self.0 >> 27;
            (self.0.wrapping_mul(0x2545_F491_4F6C_DD1D) >> 11) as f64 / (1u64 << 53) as f64
        }
        fn pick(&mut self, n: usize) -> usize {
            ((self.next() * n as f64) as usize).min(n - 1)
        }
        /// a mix like a real folder: mostly 9:16 and 16:9, some others
        fn aspect(&mut self) -> f64 {
            let base = match self.pick(20) {
                0..=7 => 9.0 / 16.0,
                8..=14 => 16.0 / 9.0,
                15..=16 => 1.0,
                17..=18 => 4.0 / 5.0,
                _ => 21.0 / 9.0,
            };
            base * (1.0 + (self.next() - 0.5) * 0.06)
        }
    }

    const SCREEN: Rect = Rect { x: 0.0, y: 0.0, w: 1920.0, h: 1080.0 };

    fn assert_tiles_cover(tree: &Tree, bounds: Rect) {
        let rects = layout(tree, bounds);
        let area: f64 = rects.iter().map(|(_, r)| r.area()).sum();
        assert!((area - bounds.area()).abs() < 1e-6, "tiles cover {area}, bounds {}", bounds.area());
        for (i, (_, a)) in rects.iter().enumerate() {
            assert!(a.w > 0.0 && a.h > 0.0);
            assert!(a.x >= bounds.x - 1e-9 && a.y >= bounds.y - 1e-9);
            assert!(a.x + a.w <= bounds.x + bounds.w + 1e-9 && a.y + a.h <= bounds.y + bounds.h + 1e-9);
            for (_, b) in &rects[i + 1..] {
                let ox = (a.x + a.w).min(b.x + b.w) - a.x.max(b.x);
                let oy = (a.y + a.h).min(b.y + b.h) - a.y.max(b.y);
                assert!(ox <= 1e-9 || oy <= 1e-9, "tiles overlap: {a:?} {b:?}");
            }
        }
    }

    fn rect_map(plan: &Plan) -> HashMap<u32, Rect> {
        plan.rects.iter().map(|p| (p.id, p.rect)).collect()
    }

    #[test]
    fn two_landscapes_stack_into_a_16_by_18_screen_uncropped() {
        let bounds = Rect::new(0.0, 0.0, 1600.0, 1800.0);
        let items = [(1, 16.0 / 9.0), (2, 16.0 / 9.0)];
        let plan = arrange(&items, bounds, &HashMap::new(), &Params::default()).unwrap();
        assert!(matches!(plan.tree, Tree::Col { .. }));
        assert!(plan.worst_crop < 1e-3, "crop {}", plan.worst_crop);
        assert_tiles_cover(&plan.tree, bounds);
    }

    #[test]
    fn four_landscapes_fill_a_16_by_9_screen_uncropped() {
        let items: Vec<(u32, f64)> = (1..=4).map(|id| (id, 16.0 / 9.0)).collect();
        let plan = arrange(&items, SCREEN, &HashMap::new(), &Params::default()).unwrap();
        assert!(plan.worst_crop < 1e-2, "crop {}", plan.worst_crop);
    }

    #[test]
    fn mixed_portrait_and_landscape_fill_the_screen_with_little_crop() {
        // two 9:16 beside a stack of two 16:9 -> aspect 9/16*2 + 8/9 = 2.0
        let items = [(1, 9.0 / 16.0), (2, 9.0 / 16.0), (3, 16.0 / 9.0), (4, 16.0 / 9.0)];
        let bounds = Rect::new(0.0, 0.0, 2000.0, 1000.0);
        let plan = arrange(&items, bounds, &HashMap::new(), &Params::default()).unwrap();
        assert!(plan.worst_crop < 0.02, "crop {}", plan.worst_crop);
        assert_tiles_cover(&plan.tree, bounds);
    }

    #[test]
    fn json_shape_matches_the_frontend() {
        let t = node(true, 0.5, Tree::Leaf { id: 1 }, Tree::Leaf { id: 2 });
        let json = serde_json::to_string(&t).unwrap();
        assert_eq!(json, r#"{"k":"row","f":0.5,"a":{"k":"leaf","id":1},"b":{"k":"leaf","id":2}}"#);
        let back: Tree = serde_json::from_str(&json).unwrap();
        assert_eq!(back, t);
        let p: Params = serde_json::from_str(r#"{"stillness":2,"frozen":[3],"inPlaceOnly":true}"#).unwrap();
        assert_eq!(p.frozen, vec![3]);
        assert!(p.in_place_only);
        assert!((p.max_crop - 0.3).abs() < 1e-12, "missing fields take defaults");
    }

    #[test]
    fn same_shape_replacement_is_a_pure_swap() {
        let mut rng = Rng(7);
        let items: Vec<(u32, f64)> = (1..=7).map(|id| (id, rng.aspect())).collect();
        let media: HashMap<u32, f64> = items.iter().copied().collect();
        let plan = arrange(&items, SCREEN, &HashMap::new(), &Params::default()).unwrap();
        let next = replace(&plan.tree, SCREEN, 3, &media, &[media[&3]], &Params::default()).unwrap();
        assert_eq!(next.kind, PlanKind::Swap);
        assert_eq!(next.moved, 0);
        assert_eq!(rect_map(&plan), rect_map(&next));
    }

    #[test]
    fn nothing_outside_the_changed_block_moves() {
        let mut rng = Rng(11);
        for round in 0..200 {
            let n = 3 + rng.pick(10);
            let items: Vec<(u32, f64)> = (1..=n as u32).map(|id| (id, rng.aspect())).collect();
            let media: HashMap<u32, f64> = items.iter().copied().collect();
            let plan = arrange(&items, SCREEN, &HashMap::new(), &Params::default()).unwrap();
            let leaf = 1 + rng.pick(n) as u32;
            let cands: Vec<f64> = (0..4).map(|_| rng.aspect()).collect();
            let next = replace(&plan.tree, SCREEN, leaf, &media, &cands, &Params::default()).unwrap();
            let region = next.region.unwrap();
            let before = rect_map(&plan);
            for p in &next.rects {
                let r = p.rect;
                let inside = r.x >= region.x - 1e-9
                    && r.y >= region.y - 1e-9
                    && r.x + r.w <= region.x + region.w + 1e-9
                    && r.y + r.h <= region.y + region.h + 1e-9;
                if !inside {
                    assert_eq!(before[&p.id], r, "round {round}: tile {} outside the block moved", p.id);
                }
            }
            assert_tiles_cover(&next.tree, SCREEN);
        }
    }

    #[test]
    fn reflow_relays_the_whole_wall_and_keeps_every_tile() {
        let mut rng = Rng(31);
        let p = Params { stillness: 0.15, ..Params::default() };
        let items: Vec<(u32, f64)> = (1..=9).map(|id| (id, rng.aspect())).collect();
        let mut media: HashMap<u32, f64> = items.iter().copied().collect();
        let mut tree = arrange(&items, SCREEN, &HashMap::new(), &p).unwrap().tree;
        let (mut moved, mut worst) = (0usize, 0.0f64);
        for round in 0..300 {
            let leaf = 1 + rng.pick(9) as u32;
            let aspect = rng.aspect();
            let plan = reflow(&tree, SCREEN, leaf, aspect, &media, &p).unwrap();
            assert_eq!(plan.kind, PlanKind::Global);
            let mut ids = plan.tree.ids();
            ids.sort();
            assert_eq!(ids, (1..=9).collect::<Vec<_>>(), "round {round}: tiles lost or added");
            assert_tiles_cover(&plan.tree, SCREEN);
            moved += plan.moved;
            worst = worst.max(plan.worst_crop);
            media.insert(leaf, aspect);
            tree = plan.tree;
        }
        eprintln!("reflow: {:.2} tiles moved per change, worst crop {:.0}%", moved as f64 / 300.0, worst * 100.0);
        // the point of the mode: the wall moves on most changes
        assert!(moved as f64 / 300.0 > 1.0, "on average {} tiles moved per change", moved as f64 / 300.0);
        assert!(worst <= p.max_crop + 1e-9, "worst crop {worst}");
        assert!(reflow(&tree, SCREEN, 99, 1.0, &media, &p).is_none());
    }

    #[test]
    fn frozen_tiles_never_move_on_replace() {
        let mut rng = Rng(23);
        for _ in 0..200 {
            let n = 4 + rng.pick(9);
            let items: Vec<(u32, f64)> = (1..=n as u32).map(|id| (id, rng.aspect())).collect();
            let media: HashMap<u32, f64> = items.iter().copied().collect();
            let plan = arrange(&items, SCREEN, &HashMap::new(), &Params::default()).unwrap();
            let leaf = 1 + rng.pick(n) as u32;
            let frozen = (leaf % n as u32) + 1; // a different tile
            let params = Params { frozen: vec![frozen], ..Params::default() };
            let cands: Vec<f64> = (0..5).map(|_| rng.aspect()).collect();
            let next = replace(&plan.tree, SCREEN, leaf, &media, &cands, &params).unwrap();
            assert_eq!(rect_map(&plan)[&frozen], rect_map(&next)[&frozen]);
        }
    }

    #[test]
    fn no_whole_wall_relayout_unless_allowed() {
        // on a 6-tile wall the root is a block the solver could re-solve;
        // with allow_global off it must never be used
        let mut rng = Rng(77);
        let n = 6u32;
        let items: Vec<(u32, f64)> = (1..=n).map(|id| (id, rng.aspect())).collect();
        let mut media: HashMap<u32, f64> = items.iter().copied().collect();
        let mut tree = arrange(&items, SCREEN, &HashMap::new(), &Params::default()).unwrap().tree;
        let params = Params { allow_global: false, ..Params::default() };
        for _ in 0..400 {
            let leaf = 1 + rng.pick(n as usize) as u32;
            let cands: Vec<f64> = (0..6).map(|_| rng.aspect()).collect();
            let plan = replace(&tree, SCREEN, leaf, &media, &cands, &params).unwrap();
            assert_ne!(plan.kind, PlanKind::Global);
            assert!(plan.moved < n as usize, "every tile moved");
            media.insert(leaf, cands[plan.choice]);
            tree = plan.tree;
        }
    }

    #[test]
    fn in_place_only_moves_nothing() {
        let mut rng = Rng(5);
        let items: Vec<(u32, f64)> = (1..=9).map(|id| (id, rng.aspect())).collect();
        let media: HashMap<u32, f64> = items.iter().copied().collect();
        let plan = arrange(&items, SCREEN, &HashMap::new(), &Params::default()).unwrap();
        let params = Params { in_place_only: true, ..Params::default() };
        let next = replace(&plan.tree, SCREEN, 4, &media, &[0.5, 1.9, 1.0], &params).unwrap();
        assert_eq!(next.kind, PlanKind::Swap);
        assert_eq!(rect_map(&plan), rect_map(&next));
    }

    #[test]
    fn insert_and_remove_keep_the_wall_whole() {
        let mut rng = Rng(3);
        let items: Vec<(u32, f64)> = (1..=5).map(|id| (id, rng.aspect())).collect();
        let mut media: HashMap<u32, f64> = items.iter().copied().collect();
        let mut tree = arrange(&items, SCREEN, &HashMap::new(), &Params::default()).unwrap().tree;
        for id in 6..=16 {
            let a = rng.aspect();
            let plan = insert(Some(&tree), SCREEN, id, a, &media, &Params::default()).unwrap();
            media.insert(id, a);
            tree = plan.tree;
            assert_eq!(tree.len(), id as usize);
            assert_tiles_cover(&tree, SCREEN);
        }
        for left in (1..16).rev() {
            let plan = remove(&tree, SCREEN, None, &media, &Params::default()).unwrap();
            tree = plan.tree;
            assert_eq!(tree.len(), left);
            assert_tiles_cover(&tree, SCREEN);
        }
        assert!(remove(&tree, SCREEN, None, &media, &Params::default()).is_none());
    }

    #[test]
    fn a_long_session_stays_calm_and_uncropped() {
        // 3000 replacements on a 9-tile wall; how often and how much it moves.
        let mut rng = Rng(42);
        let n = 9u32;
        let items: Vec<(u32, f64)> = (1..=n).map(|id| (id, rng.aspect())).collect();
        let mut media: HashMap<u32, f64> = items.iter().copied().collect();
        let mut tree = arrange(&items, SCREEN, &HashMap::new(), &Params::default()).unwrap().tree;
        let (mut swaps, mut regions, mut moved, mut worst, mut crop_sum) = (0, 0, 0usize, 0.0f64, 0.0);
        let rounds = 3000;
        let started = Instant::now();
        for _ in 0..rounds {
            let leaf = 1 + rng.pick(n as usize) as u32;
            let cands: Vec<f64> = (0..6).map(|_| rng.aspect()).collect();
            let plan = replace(&tree, SCREEN, leaf, &media, &cands, &Params::default()).unwrap();
            media.insert(leaf, cands[plan.choice]);
            match plan.kind {
                PlanKind::Swap => swaps += 1,
                _ => regions += 1,
            }
            moved += plan.moved;
            worst = worst.max(plan.worst_crop);
            crop_sum += plan.worst_crop;
            tree = plan.tree;
        }
        let per = started.elapsed().as_secs_f64() * 1000.0 / rounds as f64;
        println!(
            "{rounds} replacements: {swaps} swaps, {regions} block re-layouts, \
             {:.2} tiles moved per change, worst crop {:.1}%, mean worst crop {:.1}%, {per:.2} ms each",
            moved as f64 / rounds as f64,
            worst * 100.0,
            crop_sum / rounds as f64 * 100.0
        );
        assert!(worst <= 0.3 + 1e-9, "a tile was cropped by {worst}");
        assert!((moved as f64 / rounds as f64) < 3.0, "too much motion");
    }

    #[test]
    fn sixteen_tiles_solve_quickly() {
        let mut rng = Rng(99);
        let items: Vec<(u32, f64)> = (1..=16).map(|id| (id, rng.aspect())).collect();
        let started = Instant::now();
        let plan = arrange(&items, SCREEN, &HashMap::new(), &Params::default()).unwrap();
        let ms = started.elapsed().as_secs_f64() * 1000.0;
        println!("16 tiles from scratch: {ms:.1} ms, worst crop {:.1}%", plan.worst_crop * 100.0);
        assert_eq!(plan.rects.len(), 16);
        assert_tiles_cover(&plan.tree, SCREEN);
        assert!(ms < 2000.0);
    }

    #[test]
    fn cluster_splits_obvious_groups() {
        let v = [0.1, 0.12, 2.0, 2.1, 5.0];
        let (class, means) = cluster(&v, 3);
        assert_eq!(class[0], class[1]);
        assert_eq!(class[2], class[3]);
        assert_ne!(class[1], class[2]);
        assert_ne!(class[3], class[4]);
        assert_eq!(means.len(), 3);
    }
}
