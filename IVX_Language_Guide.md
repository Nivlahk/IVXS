# IVX Language Guide

IVX is a browser-based programming language where every program renders as a live flowchart. Write code on the left, watch the graph update on the right. No install. No server. Open `index.html` and start writing.

---

## The basics

Every line follows this pattern:

```
[incoming]  keyword  content [outgoing]
```

Lines are indented with 2 spaces to create blocks (like Python). Whitespace around operators is required — `x+1` is invalid, `x + 1` is correct.

---

## Variables

### make
Assign a value to a variable.

```
make x 10
make name "Alice"
make price 3.14
make active yes
```

Reassign with shorthand — the left side is implied:
```
make x + 1       note same as: make x x + 1
make x * 2
```

Member assignment:
```
make self.name "Alice"
```

### del
Delete a variable.
```
del x
```

### Lazy declaration with `?`
Declare a variable only if it doesn't exist yet. Useful in loops:
```
loop guess? != secret
  take int(guess)
  make tries? + 1
```

`guess?` initialises to `none`, `tries?` initialises to `0` (inferred from the `+ 1` context).

---

## Types

| Type | Example | Notes |
|------|---------|-------|
| string | `"hello"` | Use `{var}` for interpolation |
| integer | `42` | |
| float | `3.14` | |
| boolean | `yes` / `no` | |
| list | `[1, 2, 3]` | |
| dict | `{"a": 1, "b": 2}` | |
| none | `none` | Universal unset value |

### String interpolation
```
make name "Alice"
say "Hello {name}, welcome!"
```

### 2D lists
Use `;` to separate rows:
```
make grid [1, 2, 3; 4, 5, 6; 7, 8, 9]
```

Lists and dicts render as mini spreadsheet nodes in the flowchart.

---

## Operators

```
+  -  *  /  //  %  ^       arithmetic  (^ is power, // is floor division)
=  !=  <  >  <=  >=        comparison  (= is equals, not assignment)
and  or  not  xor  is  in  logical
```

### Implicit subject in conditions
```
if a > 2 and < 10        note means: a > 2 and a < 10
if a = 3 or 5            note means: a = 3 or a = 5
```

---

## Input and output

### say
Print to the terminal.
```
say "Hello, world!"
say x
say "Value is {x}"
```

### take
Read input from the user.
```
take name
take int(age)        note converts input to integer
take flt(price)      note converts to float
```

### take (file)
Open a file picker.
```
take file.csv        note CSV → list of dicts
take file.json       note JSON → object
take file.txt        note plain text → string
```

---

## Control flow

### if / else
```
if x > 10
  say "big"
else say "small"
```

Inline with `then`:
```
if x > 10 then say "big"
```

Chained:
```
if x > 10 then say "big"
else if x > 5 then say "medium"
else say "small"
```

### loop
Runs while the condition is true.
```
make i 0
loop i < 10
  say i
  make i + 1
```

### for
Iterates over a list. Binds `i` (value) and `ii` (index).
For a dictionary, Binds `i` (key) and `ii` (value)
```
make colors ["red", "green", "blue"]
for colors
  say i
```

Explicit variable name:
```
for color in colors
  say color
```

2d list
```
make grid [1, 2, 3; 4, 5, 6; 7, 8, 9]
for grid
  say i[0]    note first cell of each row
```

Nested loops use `j`/`jj` then `k`/`kk`.

### end
Terminate a flow path.
```
if x < 0
  end say "x must be positive"
```

### wait
Pause execution.
```
wait 5             note pause for 5 steps
wait x = 10        note block until x equals 10
```

---

## Functions

### fun / give
```
fun add(a, b)
  give a + b

say add(3, 4)      note 7
```

Recursive:
```
fun factorial(n)
  if n <= 1 then give 1
  give n * factorial(n - 1)
```

### give
Return a value from a function.
```
give x + 1
```

---

## Classes

```
class Dog
  fun init(name, size)

  fun speak()
    give "Woof! I am {self.name}"

make d Dog("Rex", 3)
say d.speak()
```

If you want to modify the parameters, do so directly
```
class Dog
  fun init(name, size * 2)

  fun speak()
    give "Woof! I am {self.name}"

make d Dog("Rex", 3)
say d.speak()
```

### Inheritance
```
class Animal
  fun init(name)

  fun speak()
    give self.name

class Dog(Animal)
  fun speak()
    give super.speak() + " says woof!"

make d Dog("Rex")
say d.speak()      note Rex says woof!
```

---

## Graph keywords

These control the flowchart structure and have no runtime effect.

| Keyword | Description |
|---------|-------------|
| `dot` | Explicit connector / merge point |
| `fork` | Unconditional parallel branch |
| `prev` | Route outgoing edge to previous connector |
| `next` | Route outgoing edge to next connector |
| `note` | Comment — consumes the rest of the line |

### note (block labels)
A `note` line preceded by 2+ blank lines becomes a block label in the flowchart. Optionally include a hex color:

```
note #4f46e5 Setup


make x 10
make name "Alice"


note #059669 Main loop


loop x < 100
  make x + 1
```

---

## Network

### HTTP GET
Any string that starts with `https://` auto-fetches when evaluated:
```
make data "https://jsonplaceholder.typicode.com/todos/1"
say data
```

### post
HTTP POST. Result available as `response`.
```
post "https://api.example.com/submit" {"key": "value"}
say response
```

---

## AI

### ask
Call an AI model. Returns the response as a string.
```
make key "your-api-key"
make result ask gemini "Summarise the history of computing in 3 sentences" use key
say result
```

| Model | Keyword | Free? |
|-------|---------|-------|
| Google Gemini 2.5 Flash | `gemini` or `google` | Yes — via AI Studio |
| OpenAI GPT-4o Mini | `chatgpt` or `gpt` | No |
| Anthropic Claude Haiku | `claude` or `anthropic` | No |

### use
Set a global API key for all subsequent AI calls.
```
make key "your-key"
use key
```

Inline credential (this call only):
```
make result ask gemini "Hello" use key
```

---

## Google services

Sign in with the "Sign in to Google" button to unlock these keywords. All use your signed-in Google account — no separate API keys needed.

### sheets
Open a Google Spreadsheet by name. Returns a handle with `read`, `write`, and `append` methods.

```
make s sheets "Budget 2024"

note read a range — returns a 2D list
make data s.read("A1:C10")
say data

note write a value to a cell
s.write("D1", "Updated by IVX")

note append a row to the sheet
make row ["Alice", 42, "yes"]
s.append(row)
```

### email
Send an email via Gmail.
```
email "friend@example.com" subject "Hello" body "Message here"
```

With variables:
```
make addr "friend@example.com"
make msg "This was sent from IVX!"
email addr subject "Test" body msg
```

### save / Drive
Save a value to Google Drive (into an `IVX/` folder).
```
save data report.json
save "Hello world" notes.txt
```

---

## Practical examples

### Hello world
```
say "Hello, world!"
```

### FizzBuzz
```
make i 1
loop i <= 20
  if i % 15 = 0 then say "FizzBuzz"
  else if i % 3 = 0 then say "Fizz"
  else if i % 5 = 0 then say "Buzz"
  else say i
  make i + 1
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
say "correct in {tries} tries!"
```

### AI loop
```
make key "your-gemini-key"
use key
make topic "renewable energy"
make i 0
loop i < 3
  make result ask gemini "Give me one surprising fact about {topic}"
  say result
  make i + 1
```

### Email from a spreadsheet
```
make s sheets "Signups"
make data s.read("A1:B100")
for data
  make name i[0]
  make addr i[1]
  email addr subject "Welcome {name}!" body "Thanks for signing up."
```

---

## The Lens system

Click the **Lens** button in the bottom-right panel to view your IVX program transpiled into another language.

**Languages:** Python, JavaScript, TypeScript, Pseudocode

**Importing code:** Paste Python or JavaScript into the lens panel, then click **← Import to IVX**. Lines that couldn't convert cleanly are highlighted in amber. Click **Replace IVX source** to write the result into the editor.

---

## Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+S` / `Cmd+S` | Save to Google Drive |
| `then` | Inline block — `if x > 0 then say "yes"` |
| `so` | Statement separator (same as newline) |

---

## Quick reference card

```
make x 5              assign
make x + 1            shorthand reassign
del x                 delete
take x                input
take int(x)           input with conversion
say x                 output
give x                return from function
if cond               decision
else                  alternate branch
loop cond             while loop
for list              iterate
fun name(a, b)        define function
class Name            define class
note ...              comment / block label
ask gemini "..."      AI call
email addr subj body  send email
sheets "Name"         open spreadsheet
use key               set API key
end                   terminate path
wait 5                pause
```

```
Zen of IVX

Simple is better than complex.
Complex is better than complicated.
Fast is better than slow.
There is no conflict between speed and readability.
There is no conflict between space and time.
Special cases are not special enough to break the rules.
Modularity is better than singularity.
But singularity is a foundation for modularity.
Visual clarity is as important as textual clarity.
Flow should be obvious, not hidden.
Programming is language applied to a finite problem space.
Programming languages are not languages, but lenses.
Tooling is part of the language, not an afterthought.
```