# IVX

**A programming language where the flowchart is the program.**

IVX runs entirely in the browser. Write code on the left, watch the flowchart update live on the right. No install. No server. No dependencies. Open `index.html` and start writing.

---

## What makes IVX different

Every other language treats flowcharts as documentation — something you draw after writing the code to explain it to someone else. IVX inverts that. The flowchart and the code are the same artifact. Write one line, the graph updates instantly. They are always in sync because they are the same thing.

IVX also reads like plain English. Keywords were chosen based on how people actually describe programming intent before they learn formal syntax. You `make` variables, `take` input, `say` things, and `give` values back from functions — because that is what people say.

---

## Quick start

1. Download `index.html`, `ivx.js`, and `styles.css`
2. Serve them locally:
   ```
   python3 -m http.server 8080
   ```
3. Open `http://localhost:8080`

Or host on GitHub Pages, Netlify, or any static host — no backend required.

---

## Language overview

Every line follows a single pattern:

```
[incoming]  keyword  content  [outgoing]
```

### Keywords

**Data**
| Keyword | Description |
|---------|-------------|
| `make x 5` | Assign a value. Also handles reassignment. |
| `make x x + 1` | Reassign with expression. |
| `make x + 1` | Shorthand — implied left side is `x`. |
| `take x` | Read input from the user into `x`. |
| `take int(x)` | Read input and convert type. |
| `say x` | Print value to the terminal. |
| `give x` | Return value from a function. |
| `del x` | Delete a variable. |

**Control flow**
| Keyword | Description |
|---------|-------------|
| `if condition` | Decision node with auto-generated join connector. |
| `else` | Additional branch off the nearest decision. |
| `then` | Inline branch — `if x > 0 then say "yes"` |
| `loop condition` | Loops while condition is true. Auto-generates loop connector. |
| `for list` | Iterate. Binds `i` (value) and `ii` (index/key). |
| `end` | Terminate a flow path. |
| `wait 5` | Pause for N execution steps. |
| `wait x = 10` | Block until condition is met. |

**Functions**
| Keyword | Description |
|---------|-------------|
| `fun add(a, b)` | Declare a named function. Body is indented below. |
| `give a + b` | Return a value from the function. |

**Network and AI**
| Keyword | Description |
|---------|-------------|
| `make r "https://..."` | HTTP GET — URL strings auto-fetch on evaluation. |
| `post url body` | HTTP POST. Result available as `response`. |
| `ask gemini "prompt"` | Call Google Gemini. Returns response string. |
| `ask chatgpt "prompt"` | Call OpenAI GPT-4o Mini. |
| `ask claude "prompt"` | Call Anthropic Claude Haiku. |
| `use key` | Set API credential globally for all subsequent AI calls. |
| `ask gemini "prompt" use key` | Inline credential — applies to this call only. |
| `take file.csv` | Open a file picker. CSV → list of dicts, JSON → object, TXT → string. |

**Graph keywords**
| Keyword | Description |
|---------|-------------|
| `dot` | Explicit connector/merge node. |
| `fork` | Unconditional parallel branch. No implicit merge. |
| `prev` | Route outgoing edge to nearest previous connector. |
| `next` | Route outgoing edge to nearest next connector. |
| `note` | Comment. Consumes the rest of the line. |

**Logic and literals**
```
and  or  not  xor  is  in  yes  no  none
```

### Types

| Type | Example | Notes |
|------|---------|-------|
| string | `"hello"` | `{variable}` interpolation supported |
| integer | `42` | |
| float | `3.14` | |
| boolean | `yes` / `no` | |
| list | `[1, 2, 3]` | Homogeneous |
| dict | `{"a": 1}` | |
| url | `"https://..."` | Auto-fetches on evaluation |
| none | `none` | Universal unset sentinel |

### Operators

```
+  -  *  /  //  %  ^       arithmetic (^ is right-associative)
=  !=  <  >  <=  >=        comparison  (= is comparison only, not assignment)
and  or  not  xor  is  in  logical
```

Whitespace around operators is enforced. `x-5` is invalid. `x - 5` is required.

### Table indexing (2D lists)

IVX supports table-style indexing on 2D lists:

```
make t [[11,12,13],[21,22,23],[31,32,33]]

say t[1]         note second row (0-based numeric index)
say t[1,2]       note row 1, col 2 (0-based numeric index)
say t[,1]        note full column 1
say t[0:2, 1:3]  note row/col slicing
```

Excel-style cell and range notation is also supported:

```
say t[A0]        note header row cell (A0 = first row, first column)
say t[B1]        note second row, column B
say t[A1:B2]     note rectangular range, inclusive bounds
say t[2, "B"]    note third row, column B
```

Row numbers in Excel-style references are zero-based in IVX (`A0`, `B0`, ...), so row `0` can represent headers.

For 2D list typing, IVX treats row `0` as header-friendly: column type checks are enforced across data rows (`1+`), while header cells may use different types.

### String interpolation

```
make name "Alice"
say "Hello {name}, welcome to IVX"
```

### Lazy declaration — the `?` suffix

Declare a variable at global scope with an inferred default, without a setup line:

```
loop guess? != secret
  take int(guess)
  make tries? + 1
```

`guess?` declares `guess` as `none` if it doesn't exist (inferred from `secret`'s type).
`tries?` declares `tries` as `0` (inferred from the `+ 1` arithmetic context).

### Classes

IVX supports constructor-style classes that infer field initialization from an `init()` method:

```
class Dog
  fun init(size, name)
    make self.size size
    make self.name name

make d Dog(3, "Rex")
say d.size   note 3
say d.name   note Rex
```

Each `init()` parameter becomes a field on the created instance automatically, so you can reference `self.size` and `self.name` immediately inside methods and after construction.

Methods can live under the class body as indented `fun` declarations, and they get `self` automatically through closure binding:

```
class Counter
  fun init(value)
    make self.value value
  fun inc()
    make self.value self.value + 1
    give self.value

make c Counter(1)
say c.inc()
say c.inc()
```

Subclasses use the superclass name in parentheses, and `super` resolves inherited members inside methods:

```
class Animal
  fun init(name)
    make self.name name
  fun speak()
    give self.name

class Dog(Animal)
  fun speak()
    give super.speak() + "!"

make d Dog("Rex")
say d.speak()   note Rex!
say d.name      note Rex
```

### Implicit subject in conditions

```
if a > 2 and < 10          note means: a > 2 and a < 10
if a = 3 or 5              note means: a = 3 or a = 5
```

---

## Examples

### Hello world
```
say "Hello, World!"
```

### FizzBuzz
```
make go 1
loop go <= 20
  if go % 3 = 0 and % 5 = 0 then say "FizzBuzz"
  else if go % 3 = 0 then say "Fizz"
  else if go % 5 = 0 then say "Buzz"
  else say go
  make go + 1
```

### Factorial
```
fun factorial(n)
  if n <= 1 then give 1
  give n * factorial(n - 1)

take int(n)
say factorial(n)
```

### Guessing game
```
make secret 7
loop guess? != secret
  take int(guess)
  make tries? + 1
  if guess < secret then say "too low"
  else if guess > secret then say "too high"
say "correct!"
say tries
```

### AI call
```
make key "your-gemini-api-key"
use key
make summary ask gemini "Summarize the history of programming languages in 3 sentences"
say summary
```

### AI generator / critic loop
```
make key "your-gemini-api-key"
use key
make topic "a mobile app that helps people learn to cook"
make proposal ask gemini "Write a one-paragraph business proposal for: {topic}"
loop rounds? < 5
  make verdict ask gemini "Judge this proposal. Start with APPROVED or REJECTED.\n\nProposal: {proposal}"
  say "── Round {rounds} ──"
  say verdict
  if "APPROVED" in verdict
    say proposal
    end
  make proposal ask gemini "Revise this proposal based on this feedback.\n\nProposal: {proposal}\n\nFeedback: {verdict}"
  make rounds + 1
say "── Max rounds reached ──"
say proposal
```

### HTTP fetch
```
make data "https://jsonplaceholder.typicode.com/todos/1"
say data
```

---

## Google Drive integration

IVX stores your programs in your own Google Drive, in a folder called `IVX/`. Each user authenticates with their own Google account — your files stay in your Drive, not anyone else's.

### Setup (for self-hosting)

1. Create a project in [Google Cloud Console](https://console.cloud.google.com)
2. Enable the Google Drive API
3. Create an OAuth 2.0 Client ID (Web application type)
4. Add your hosted URL as an authorized JavaScript origin
5. Replace the `DRIVE_CLIENT_ID` constant in `ivx.js` with your Client ID

### Usage

1. Open IVX in a browser served over HTTP (not `file://`)
2. Click "Sign in to Google" in the file panel
3. Authorize IVX to access your Drive
4. Use ＋ New, click files to open, ↑ Save or `Ctrl+S` to save

The `drive.file` scope is used — IVX can only see files it created. Your existing Drive contents are never visible to IVX.

---

## AI model reference

| Model name | Provider | Free tier |
|------------|----------|-----------|
| `gemini` or `google` | Google Gemini 2.5 Flash | Yes — via Google AI Studio |
| `chatgpt` or `gpt` | OpenAI GPT-4o Mini | No |
| `claude` or `anthropic` | Anthropic Claude Haiku | No |

Get a free Gemini API key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey).

---

## Implementation

IVX is a single-file JavaScript implementation bundled with the editor:

| Stage | Description |
|-------|-------------|
| Lexer | Tokenizes source. Handles INDENT/DEDENT, `so`/`then` normalization, lazy `?` suffix. |
| Parser | Recursive descent. Produces an AST with panic-mode error recovery. |
| Type checker | Static inference. Checks homogeneous lists, function signatures, type compatibility. |
| Interpreter | Async tree-walking interpreter. Hooks for output, input, step, and wait. |
| Graph builder | Text-based flowchart builder. Handles decisions, loops, branches, and joins. |
| Renderer | SVG-based flowchart renderer with layout, minimap, pan/zoom, and animation. |

The entire pipeline — language runtime, flowchart renderer, editor, terminal, and Drive integration — ships as two files: `index.html` and `ivx.js`.

---

## Execution playback

Run a program with the ▶ Run button. After execution completes, the flowchart animates the actual execution path at human speed — showing exactly which branches were taken, how many times the loop ran, which conditions were true. Use the speed control to adjust playback rate.

---
