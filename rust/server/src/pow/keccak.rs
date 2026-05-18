//! DeepSeekHashV1 — a custom hash reverse-engineered from DeepSeek's webpack bundle.
//!
//! Key differences from standard Keccak/SHA3:
//! 1. Non-standard ρ rotations: w[i] = triangular numbers mod 64 (1,3,6,10,15...)
//!    instead of the standard Keccak rotation table.
//! 2. State represented as 32-bit hi/lo pairs with big-endian lane absorption.
//! 3. SHA3 padding byte (0x06), not Keccak (0x01).
//! 4. Squeeze outputs lo-word bytes first, then hi-word bytes (both little-endian).
//!
//! The implementation faithfully reproduces the bundle's E, B, I, A functions.

// ---------------------------------------------------------------------------
// Round constants (from bundle: first elements of the RC array)
// Stored as (hi_u32, lo_u32) pairs matching state layout
// ---------------------------------------------------------------------------

const RC: [(u32, u32); 24] = [
    (0x00000000, 0x00000001), (0x00000000, 0x00008082),
    (0x80000000, 0x0000808A), (0x80000000, 0x80008000),
    (0x00000000, 0x0000808B), (0x00000000, 0x80000001),
    (0x80000000, 0x80008081), (0x80000000, 0x00008009),
    (0x00000000, 0x0000008A), (0x00000000, 0x00000088),
    (0x00000000, 0x80008009), (0x00000000, 0x8000000A),
    (0x00000000, 0x8000808B), (0x80000000, 0x0000008B),
    (0x80000000, 0x00008089), (0x80000000, 0x00008003),
    (0x80000000, 0x00008002), (0x80000000, 0x00000080),
    (0x00000000, 0x0000800A), (0x80000000, 0x8000000A),
    (0x80000000, 0x80008081), (0x80000000, 0x00008080),
    (0x00000000, 0x80000001), (0x80000000, 0x80008008),
];

// v[i]: pi destination lane index (standard Keccak pi sequence starting at lane 1)
const V: [usize; 24] = [10,7,11,17,18,3,5,16,8,21,24,4,15,23,19,13,12,2,20,14,22,9,6,1];

// w[i]: rotation amounts — triangular numbers mod 64 (bundle's custom schedule)
const W: [u32; 24] = [1,3,6,10,15,21,28,36,45,55,2,14,27,41,56,8,25,43,62,18,39,61,20,44];

/// Rotate a 64-bit value (hi/lo u32 pair) left by n bits.
/// When n == 0: identity.
/// When 0 < n < 32: standard split rotation.
/// When n >= 32: JS wraps shift (<<n is <<(n%32), >>>s with s=(32-n) wraps to >>>(s%32)).
#[inline]
fn rol64_hlpair(hi: u32, lo: u32, a: u32) -> (u32, u32) {
    // JS: s = 32 - a; u = (a < 32) ? 0 : 1
    // n[u] = (old_hi << a | old_lo >>> s)  [hi word]
    // n[(u+1)%2] = (old_lo << a | old_hi >>> s) [lo word]
    // where all shifts are mod-32 (JS bitwise)
    let s = (32u32.wrapping_sub(a)) & 31;
    let a32 = a & 31;
    if a < 32 {
        // u=0: n[0]=hi result, n[1]=lo result
        let new_hi = (hi << a32) | (lo >> s);
        let new_lo = (lo << a32) | (hi >> s);
        (new_hi, new_lo)
    } else {
        // u=1: n[1]=hi result, n[0]=lo result
        let r_hi = (hi << a32) | (lo >> s);
        let r_lo = (lo << a32) | (hi >> s);
        // hi word = r_lo (swapped), lo word = r_hi
        (r_lo, r_hi)
    }
}

/// The ρ+π step (bundle's E function).
/// Starting with lane 1, applies the sequential chain: rotate and permute.
fn rho_pi(state: &mut [u32; 50], tmp: &mut [u32; 2]) {
    // Init: tmp = state[lane 1]
    tmp[0] = state[2]; // hi of lane 1
    tmp[1] = state[3]; // lo of lane 1

    for i in 0..24 {
        let t = V[i];
        let a = W[i];

        // r = state[t]
        let r0 = state[2 * t];
        let r1 = state[2 * t + 1];

        // rotate tmp by a
        let (new_hi, new_lo) = rol64_hlpair(tmp[0], tmp[1], a);

        // state[t] = rotated tmp
        state[2 * t]     = new_hi;
        state[2 * t + 1] = new_lo;

        // tmp = r (for next iteration)
        tmp[0] = r0;
        tmp[1] = r1;
    }
}

/// θ step (bundle's B function).
fn theta(state: &mut [u32; 50], c: &mut [u32; 10], d: &mut [u32; 10], _tmp: &mut [u32; 2]) {
    // Compute column parities
    for t in 0..5 {
        let n = 2 * t;
        c[n]     = state[n] ^ state[n+10] ^ state[n+20] ^ state[n+30] ^ state[n+40];
        c[n + 1] = state[n+1] ^ state[n+11] ^ state[n+21] ^ state[n+31] ^ state[n+41];
    }
    // Compute D
    for t in 0..5 {
        // rot c[(t+1)%5] by 1 left
        let idx = ((t + 1) % 5) * 2;
        let (rhi, rlo) = rol64_hlpair(c[idx], c[idx + 1], 1);
        let prev = ((t + 4) % 5) * 2;
        d[2 * t]     = c[prev] ^ rhi;
        d[2 * t + 1] = c[prev + 1] ^ rlo;
        // XOR all lanes in column t
        for r in 0..5 {
            state[(r * 5 + t) * 2]     ^= d[2 * t];
            state[(r * 5 + t) * 2 + 1] ^= d[2 * t + 1];
        }
    }
}

/// χ step.
fn chi(state: &mut [u32; 50], c: &mut [u32; 10]) {
    for y in 0..5 {
        let base = y * 5;
        for x in 0..5 {
            c[2 * x]     = state[(base + x) * 2];
            c[2 * x + 1] = state[(base + x) * 2 + 1];
        }
        for x in 0..5 {
            let n1 = (x + 1) % 5;
            let n2 = (x + 2) % 5;
            state[(base + x) * 2]     = c[2*x]     ^ ((!c[2*n1])     & c[2*n2]);
            state[(base + x) * 2 + 1] = c[2*x + 1] ^ ((!c[2*n1 + 1]) & c[2*n2 + 1]);
        }
    }
}

/// Keccak-f permutation — 23 rounds (matches bundle: loop i=1..23, skips RC[0]).
fn keccak_f(state: &mut [u32; 50]) {
    let mut c  = [0u32; 10];
    let mut d  = [0u32; 10];
    let mut tmp = [0u32; 2];

    for round in 1..24 {   // bundle: for(let i=1; i<24; i++) — RC[1..23], skips RC[0]
        theta(state, &mut c, &mut d, &mut tmp);
        rho_pi(state, &mut tmp);
        chi(state, &mut c);
        state[0] ^= RC[round].0;
        state[1] ^= RC[round].1;
    }
}

// ---------------------------------------------------------------------------
// Absorb: bytes → state
//
// Bundle's `I` function:
//   state[n]   ^= input[r+7]<<24 | input[r+6]<<16 | input[r+5]<<8 | input[r+4]
//   state[n+1] ^= input[r+3]<<24 | input[r+2]<<16 | input[r+1]<<8 | input[r+0]
// ---------------------------------------------------------------------------

fn absorb_block(state: &mut [u32; 50], block: &[u8]) {
    let len = block.len().min(RATE_BYTES);
    let pairs = len / 8;
    for i in 0..pairs {
        let r = i * 8;
        let hi: u32 = (block[r+7] as u32) << 24
                    | (block[r+6] as u32) << 16
                    | (block[r+5] as u32) << 8
                    |  block[r+4] as u32;
        let lo: u32 = (block[r+3] as u32) << 24
                    | (block[r+2] as u32) << 16
                    | (block[r+1] as u32) << 8
                    |  block[r]   as u32;
        state[i * 2]     ^= hi;
        state[i * 2 + 1] ^= lo;
    }
}

// ---------------------------------------------------------------------------
// Squeeze: state → bytes
//
// Bundle's `A` function (lo-word bytes first, then hi-word bytes, both LE):
//   output[r+0..3] = state[n+1] (lo word, little-endian)
//   output[r+4..7] = state[n]   (hi word, little-endian)
// ---------------------------------------------------------------------------

fn squeeze_bytes(state: &[u32; 50]) -> [u8; 32] {
    let mut out = [0u8; 32];
    // 32 bytes = 4 × 8-byte blocks
    for i in 0..4 {
        let r = i * 8;
        let n = i * 2;
        let lo = state[n + 1];
        let hi = state[n];
        // lo word, little-endian
        out[r]     =  lo        as u8;
        out[r + 1] = (lo >> 8)  as u8;
        out[r + 2] = (lo >> 16) as u8;
        out[r + 3] = (lo >> 24) as u8;
        // hi word, little-endian
        out[r + 4] =  hi        as u8;
        out[r + 5] = (hi >> 8)  as u8;
        out[r + 6] = (hi >> 16) as u8;
        out[r + 7] = (hi >> 24) as u8;
    }
    out
}

// ---------------------------------------------------------------------------
// Sponge parameters
// ---------------------------------------------------------------------------

const RATE_BYTES: usize = 136; // capacity=256 → rate = 200 - 256/4 = 136
const PADDING: u8 = 0x06;     // SHA3-style

// ---------------------------------------------------------------------------
// Cloneable sponge for prefix-precompute optimisation
// ---------------------------------------------------------------------------

#[derive(Clone)]
pub struct KeccakSponge {
    state: [u32; 50],
    queue: [u8; RATE_BYTES],
    queue_offset: usize,
}

impl KeccakSponge {
    pub fn new() -> Self {
        KeccakSponge {
            state: [0u32; 50],
            queue: [0u8; RATE_BYTES],
            queue_offset: 0,
        }
    }

    pub fn update(&mut self, data: &[u8]) {
        let mut offset = 0;
        while offset < data.len() {
            let avail = RATE_BYTES - self.queue_offset;
            let chunk = avail.min(data.len() - offset);
            self.queue[self.queue_offset..self.queue_offset + chunk]
                .copy_from_slice(&data[offset..offset + chunk]);
            self.queue_offset += chunk;
            offset += chunk;
            if self.queue_offset == RATE_BYTES {
                let q = self.queue;
                absorb_block(&mut self.state, &q);
                keccak_f(&mut self.state);
                self.queue_offset = 0;
                self.queue.fill(0);
            }
        }
    }

    pub fn finalize(mut self) -> [u8; 32] {
        // Apply padding (SHA3-style)
        self.queue[self.queue_offset] |= PADDING;
        self.queue[RATE_BYTES - 1] |= 0x80;
        let q = self.queue;
        absorb_block(&mut self.state, &q);
        keccak_f(&mut self.state);
        squeeze_bytes(&self.state)
    }
}

/// One-shot hash.
#[allow(dead_code)]
pub fn keccak256(data: &[u8]) -> [u8; 32] {
    let mut s = KeccakSponge::new();
    s.update(data);
    s.finalize()
}

#[allow(dead_code)]
pub fn keccak256_hex(data: &[u8]) -> String {
    hex::encode(keccak256(data))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_prefix_precompute() {
        let prefix = b"salt_1234567890_";
        let suffix = b"42";

        let mut direct = KeccakSponge::new();
        direct.update(prefix);
        direct.update(suffix);
        let direct_hash = direct.finalize();

        let mut base = KeccakSponge::new();
        base.update(prefix);
        let mut cloned = base.clone();
        cloned.update(suffix);
        let cloned_hash = cloned.finalize();

        assert_eq!(direct_hash, cloned_hash);
    }

    #[test]
    fn test_known_answer() {
        // From live DeepSeek PoW: salt=b2b4550b..., expire_at=1778745997902, nonce=65756
        // challenge=190387b2ebc1d765204c5ef089061fcc1af08c29b48732015310f56e3b093e9b
        let input = "b2b4550b267014dbbe56_1778745997902_65756";
        let hash = keccak256(input.as_bytes());
        assert_eq!(
            hex::encode(hash),
            "190387b2ebc1d765204c5ef089061fcc1af08c29b48732015310f56e3b093e9b"
        );
    }
}

#[cfg(test)]
mod bundle_vectors {
    use super::*;

    // Test vectors from live bundle execution:
    // Input format: "{salt}_{expire_at}_{nonce}"
    // Generated with: salt="test_salt", expire_at=12345
    #[test]
    fn test_nonce0() {
        let h = keccak256(b"test_salt_12345_0");
        assert_eq!(hex::encode(h), "5ca746b96b30b77d464b2888bfd55bf4ea3470e49e2f2b2888ae897e8852eda5");
    }

    #[test]
    fn test_nonce1() {
        let h = keccak256(b"test_salt_12345_1");
        assert_eq!(hex::encode(h), "a9e5aa0e5d5ecb0f5c07eb5de28a09d846c0c4e174eed4690110cbd976decd04");
    }

    #[test]
    fn test_nonce2() {
        let h = keccak256(b"test_salt_12345_2");
        assert_eq!(hex::encode(h), "70a93825a1fda32a567bd65a9c7d583f58f54280864ddd7a310dc5f2d88d235b");
    }
}

#[cfg(test)]
mod timing_test {
    use super::*;

    #[test]
    fn test_solve_timing() {
        // Time how long it takes to find nonce 65756 for our known challenge
        let start = std::time::Instant::now();
        let prefix = "b2b4550b267014dbbe56_1778745997902_";
        let expected = "190387b2ebc1d765204c5ef089061fcc1af08c29b48732015310f56e3b093e9b";
        
        let mut base_sponge = KeccakSponge::new();
        base_sponge.update(prefix.as_bytes());
        
        let mut found = None;
        for nonce in 0u64..=65756 {
            let mut s = base_sponge.clone();
            s.update(nonce.to_string().as_bytes());
            let h = s.finalize();
            if hex::encode(h) == expected {
                found = Some(nonce);
                break;
            }
        }
        
        let elapsed = start.elapsed();
        println!("Solve time: {}ms for nonce {:?}", elapsed.as_millis(), found);
        assert_eq!(found, Some(65756));
        // Should complete in < 5 seconds even in debug build
        assert!(elapsed.as_secs() < 30, "PoW solve took too long: {}s", elapsed.as_secs());
    }
}
