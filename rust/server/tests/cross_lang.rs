use aes::cipher::consts::U16;
use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{AesGcm, Nonce};
use aes::Aes256;
use base64::Engine;

type Aes256GcmN16 = AesGcm<Aes256, U16>;

fn main() {
    let key_hex = "6513449c37e7b1a04f8a514cb04526fe350d7624a96b3f2a38a6d8b14ee0aa6a";
    let key = hex::decode(key_hex).unwrap();
    let key: [u8; 32] = key.try_into().unwrap();

    let wire_b64 = "DXU3W/QWJCkqCXB+wHQ+ziwfsJGDs+fNCAnQ4fM7YOdi48MffBVmZ+9hrBbTIQAcMpi2ijHdbVVnLX5uqQ==";
    let wire = base64::engine::general_purpose::STANDARD.decode(wire_b64).unwrap();

    let (nonce_bytes, rest) = wire.split_at(16);
    let (tag_bytes, ciphertext) = rest.split_at(16);

    let nonce = Nonce::from_slice(nonce_bytes);
    let cipher = Aes256GcmN16::new_from_slice(&key).unwrap();

    let mut combined = Vec::with_capacity(ciphertext.len() + 16);
    combined.extend_from_slice(ciphertext);
    combined.extend_from_slice(tag_bytes);

    match cipher.decrypt(nonce, combined.as_slice()) {
        Ok(plaintext) => println!("OK: {}", String::from_utf8_lossy(&plaintext)),
        Err(e) => println!("FAIL: {:?}", e),
    }
}
