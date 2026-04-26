# IVX Standard Library

Hosted at `https://ivxs.tech/std/`. Import any module with `from`:

```
from "https://ivxs.tech/std/math"
  use fibonacci as fib
  use clamp
  use average
```

## Modules

| Module | Description | Key functions |
|--------|-------------|---------------|
| `math` | Mathematics & statistics | `fibonacci`, `clamp`, `lerp`, `isPrime`, `average`, `stddev`, `median`, `percentile` |
| `text` | String utilities | `titleCase`, `slug`, `truncate`, `camelToSnake`, `levenshtein`, `wrap`, `wordCount` |
| `list` | List operations | `chunk`, `flatten`, `zip`, `groupBy`, `shuffle`, `sample`, `tally`, `rotate` |
| `date` | Date manipulation | `today`, `addDays`, `formatDate`, `weekday`, `isWeekend`, `businessDaysUntil` |
| `validate` | Input validation | `isEmail`, `isURL`, `isPhone`, `isDate`, `isStrongPassword`, `validate` |
| `color` | Color utilities | `hexToRgb`, `rgbToHex`, `lighten`, `darken`, `contrastColor`, `mix` |
| `geo` | Geography & distance | `distanceKm`, `distanceMiles`, `nearest`, `bbox`, `sortByDistance` |
| `finance` | Financial calculations | `compoundInterest`, `monthlyPayment`, `amortize`, `roi`, `npv`, `taxBracket` |
| `random` | Random utilities | `dice`, `pickOne`, `pickMany`, `uuid`, `randomPassword`, `normalRandom` |

## Usage examples

### math
```
from "https://ivxs.tech/std/math"
  use fibonacci as fib
  use average
  use isPrime

say fib(10)
say average([4, 7, 2, 9, 1])
say isPrime(17)
```

### text
```
from "https://ivxs.tech/std/text"
  use titleCase
  use slug
  use truncate

say titleCase("hello world")
say slug("My Blog Post Title!")
say truncate("A very long string", 10)
```

### date
```
from "https://ivxs.tech/std/date"
  use today
  use addDays
  use formatDate
  use businessDaysUntil

make t today()
say formatDate(t, "long")
say addDays(t, 30)
say businessDaysUntil(t, "2025-12-31")
```

### validate
```
from "https://ivxs.tech/std/validate"
  use isEmail
  use isStrongPassword
  use validate

take email
if isEmail(email)
  say "valid"
else say "invalid"
```

### finance
```
from "https://ivxs.tech/std/finance"
  use monthlyPayment
  use amortize

take flt(principal)
take flt(rate)
take int(years)
say monthlyPayment(principal, rate, years * 12)
```

## Notes

- All modules are written in IVX — no JavaScript
- Functions are pure where possible (no side effects)
- Date functions use ISO format `YYYY-MM-DD`
- Geo distances are in kilometres by default
- Finance rates are decimals (0.05 = 5%)
