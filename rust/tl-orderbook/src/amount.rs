//! Exact decimal quantities as checked scaled integers.
//!
//! # Scale and rounding
//!
//! Legacy code stores amounts and prices as JS `number` (IEEE-754 double) and
//! rounds every derived value with `safeNumber(n) = parseFloat(n.toFixed(6))`
//! (`src/utils/pure/mix.pure.ts`). Six decimal places is therefore the legacy
//! contract, and this crate stores every quantity as an integer count of
//! `10^-6` units: [`SCALE`] = 1_000_000.
//!
//! * Addition and subtraction are exact; subtraction below zero is refused.
//! * `amount * price` ([`notional`]) is computed exactly in `u128` and rounded
//!   half-up to six decimals, which is what `toFixed(6)` does to the exact
//!   decimal expansion of the double product. The two agree whenever the
//!   double product is within half an ulp of the decimal product (the
//!   "safe domain": inputs with at most six decimals and modest magnitude,
//!   e.g. amounts in multiples of 0.001 and prices in multiples of 0.01).
//!   Outside that domain a JS double may round differently; the Rust value is
//!   the mathematically exact one.
//! * Values above [`MAX_RAW`] (1e9 whole units) are refused so that no
//!   product can overflow.

use std::fmt;

use crate::error::Error;

/// Raw units per whole unit (six decimal places).
pub const SCALE: u64 = 1_000_000;
/// Largest accepted raw value: one billion whole units.
pub const MAX_RAW: u64 = 1_000_000_000_000_000;

fn parse6(s: &str) -> Result<u64, Error> {
    if s.is_empty() || !s.is_ascii() {
        return Err(Error::BadDecimal);
    }
    let (int_part, frac_part) = match s.split_once('.') {
        Some((i, f)) => (i, f),
        None => (s, ""),
    };
    if int_part.is_empty() || int_part.len() > 10 || !int_part.bytes().all(|b| b.is_ascii_digit())
    {
        return Err(Error::BadDecimal);
    }
    if s.contains('.') && frac_part.is_empty() {
        return Err(Error::BadDecimal);
    }
    if !frac_part.bytes().all(|b| b.is_ascii_digit()) {
        return Err(Error::BadDecimal);
    }
    if frac_part.len() > 6 {
        return Err(Error::TooManyDecimals);
    }
    let whole: u64 = int_part.parse().map_err(|_| Error::BadDecimal)?;
    let mut frac: u64 = if frac_part.is_empty() {
        0
    } else {
        frac_part.parse().map_err(|_| Error::BadDecimal)?
    };
    for _ in frac_part.len()..6 {
        frac *= 10;
    }
    whole
        .checked_mul(SCALE)
        .and_then(|w| w.checked_add(frac))
        .ok_or(Error::AmountTooLarge)
}

macro_rules! scaled {
    ($(#[$meta:meta])* $name:ident) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
        pub struct $name(u64);

        impl $name {
            pub const ZERO: $name = $name(0);

            /// Wrap a raw count of 1e-6 units, refusing values above [`MAX_RAW`].
            pub fn from_raw(raw: u64) -> Result<Self, Error> {
                if raw > MAX_RAW {
                    Err(Error::AmountTooLarge)
                } else {
                    Ok($name(raw))
                }
            }

            /// The raw count of 1e-6 units.
            pub const fn raw(self) -> u64 {
                self.0
            }

            pub const fn is_zero(self) -> bool {
                self.0 == 0
            }

            /// Parse a plain decimal such as `"12"` or `"0.000125"` (at most six decimals).
            pub fn parse(s: &str) -> Result<Self, Error> {
                parse6(s).and_then(Self::from_raw)
            }

            /// Convert a JS-style double only when it is *exactly* a six-decimal
            /// number (the value the legacy `toFixed(6)` would leave unchanged).
            pub fn from_f64_exact(x: f64) -> Result<Self, Error> {
                if !x.is_finite() || x < 0.0 || x > (MAX_RAW / SCALE) as f64 {
                    return Err(Error::NotRepresentable);
                }
                let n = (x * SCALE as f64).round();
                if n < 0.0 || n > MAX_RAW as f64 {
                    return Err(Error::NotRepresentable);
                }
                let n = n as u64;
                if (n as f64) / (SCALE as f64) != x {
                    return Err(Error::NotRepresentable);
                }
                Self::from_raw(n)
            }

            /// Exact subtraction; `None` if it would go below zero.
            pub fn checked_sub(self, other: Self) -> Option<Self> {
                self.0.checked_sub(other.0).map($name)
            }

            /// Smaller of the two values (JS `Math.min`).
            pub fn min_of(self, other: Self) -> Self {
                if self.0 <= other.0 {
                    self
                } else {
                    other
                }
            }
        }

        impl fmt::Display for $name {
            /// Always six decimals, like JS `toFixed(6)`.
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                write!(f, "{}.{:06}", self.0 / SCALE, self.0 % SCALE)
            }
        }
    };
}

scaled!(
    /// A quantity of an asset or contract, in 1e-6 units.
    Amount
);
scaled!(
    /// A limit price, in 1e-6 units.
    Price
);

/// `amount * price`, exact, rounded half-up to six decimals
/// (legacy: `safeNumber(amount * price)`). Fails if the result exceeds
/// [`MAX_RAW`].
pub fn notional(amount: Amount, price: Price) -> Result<Amount, Error> {
    let product = (amount.raw() as u128) * (price.raw() as u128);
    let rounded = (product + (SCALE as u128) / 2) / (SCALE as u128);
    if rounded > MAX_RAW as u128 {
        return Err(Error::NotionalOverflow);
    }
    // rounded <= MAX_RAW fits u64
    Amount::from_raw(rounded as u64).map_err(|_| Error::NotionalOverflow)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_and_display_round_trip() {
        for s in ["0", "1", "0.5", "123.456789", "0.000001", "1000000000"] {
            let a = Amount::parse(s).unwrap();
            let shown = a.to_string();
            assert_eq!(Amount::parse(&shown).unwrap(), a, "{s}");
        }
        assert_eq!(Amount::parse("1.5").unwrap().to_string(), "1.500000");
        assert_eq!(Amount::parse("0.000125").unwrap().raw(), 125);
    }

    #[test]
    fn parse_rejects_malformed() {
        for s in ["", ".", "1.", ".5", "-1", "+1", "1e3", "1.2.3", " 1", "1 ", "0x10", "\u{ff11}"] {
            assert_eq!(Amount::parse(s), Err(Error::BadDecimal), "{s:?}");
        }
        assert_eq!(Amount::parse("0.1234567"), Err(Error::TooManyDecimals));
        assert_eq!(Amount::parse("1000000001"), Err(Error::AmountTooLarge));
        assert_eq!(Amount::parse("99999999999"), Err(Error::BadDecimal));
        assert!(Amount::parse("1000000000").is_ok());
    }

    #[test]
    fn notional_rounds_half_up_exactly() {
        let a = Amount::parse("1.5").unwrap();
        let p = Price::parse("2.5").unwrap();
        assert_eq!(notional(a, p).unwrap().to_string(), "3.750000");
        // 0.000001 * 0.5 = 0.0000005 -> rounds up to 0.000001
        let a = Amount::parse("0.000001").unwrap();
        let p = Price::parse("0.5").unwrap();
        assert_eq!(notional(a, p).unwrap().raw(), 1);
        // 0.000001 * 0.4 -> 0.0000004 -> 0
        let p = Price::parse("0.4").unwrap();
        assert_eq!(notional(a, p).unwrap().raw(), 0);
    }

    #[test]
    fn notional_overflow_is_an_error() {
        let a = Amount::parse("1000000000").unwrap();
        let p = Price::parse("2").unwrap();
        assert_eq!(notional(a, p), Err(Error::NotionalOverflow));
        let p = Price::parse("1").unwrap();
        assert_eq!(notional(a, p).unwrap().raw(), MAX_RAW);
    }

    #[test]
    fn f64_exact_conversion() {
        assert_eq!(Amount::from_f64_exact(0.1).unwrap().raw(), 100_000);
        assert_eq!(Amount::from_f64_exact(2.675).unwrap().raw(), 2_675_000);
        assert_eq!(Amount::from_f64_exact(0.0000005), Err(Error::NotRepresentable));
        assert_eq!(Amount::from_f64_exact(f64::NAN), Err(Error::NotRepresentable));
        assert_eq!(Amount::from_f64_exact(-1.0), Err(Error::NotRepresentable));
        assert_eq!(Amount::from_f64_exact(f64::INFINITY), Err(Error::NotRepresentable));
        assert_eq!(Amount::from_f64_exact(2e9), Err(Error::NotRepresentable));
    }

    #[test]
    fn checked_sub_and_min() {
        let a = Amount::parse("3").unwrap();
        let b = Amount::parse("1.25").unwrap();
        assert_eq!(a.checked_sub(b).unwrap().to_string(), "1.750000");
        assert_eq!(b.checked_sub(a), None);
        assert_eq!(a.min_of(b), b);
    }
}
