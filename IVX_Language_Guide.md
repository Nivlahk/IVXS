# IVX Language Guide

IVX is a browser-based programming language where every program renders as a live flowchart. Write code on the left, watch the graph update on the right. No install. No server. Visit [ivxs.tech](https://ivxs.tech) and start writing.

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
| string | `"hello"` | Use `{expr}` for interpolation |
| integer | `42` | |
| float | `3.14` | |
| boolean | `yes` / `no` | |
| list | `[1, 2, 3]` | |
| dict | `{"a": 1, "b": 2}` | |
| none | `none` | Universal unset value |

### String interpolation
Braces evaluate any expression inline:
```
make name "Alice"
say "Hello {name}, welcome!"
say "Balance: {self.balance}"
say "Area: {c.area()}"
say "Next: {x + 1}"
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
For a dictionary, binds `i` (key) and `ii` (value).
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

2D list:
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
Pause execution or block until a trigger fires.

```
wait 5                               note pause for 5 steps
wait x = 10                          note block until x equals 10
wait email by "addr@example.com"     note block until email from that address
wait sheets "Budget" by "row added"  note block until a row is added
wait time "09:00"                    note block until 9am
wait every time "09:00"              note recurring — fires every day at 9am
```

`wait` blocks with Google triggers deploy automatically to Apps Script when your program runs. After the first deploy, run `ivxSetupTriggers()` once in the Apps Script editor to activate them.

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

### Parameter defaults
Use `?` after a parameter name to set a default value:
```
fun greet(name, greeting? "Hello")
  say "{greeting}, {name}!"

greet("Alice")          note Hello, Alice!
greet("Bob", "Hi")      note Hi, Bob!
```

### Parameter transforms
Include an operator to transform the incoming argument before use:
```
fun price(amount * 1.1)
  give amount              note amount is already marked up 10%
```

Combine defaults and transforms:
```
fun invest(amount? 100 * 1.05)   note default 100, apply 5% growth
  give amount
```

---

## Classes

### init
Use `init` to declare a constructor. Parameters auto-assign to `self` — no body needed.

```
class Dog
  init(name, breed)

  fun speak()
    say "{self.name} says woof!"

make d Dog("Rex", "Labrador")
d.speak()
```

`self.name` and `self.breed` are set automatically from the arguments.

### Parameter defaults in init
```
class BankAccount
  init(owner, balance? 0)

  fun status()
    say "{self.owner} has ${self.balance}"

make acc BankAccount("Alice", 100)
make acc2 BankAccount("Bob")       note balance defaults to 0
acc.status()                       note Alice has $100
acc2.status()                      note Bob has $0
```

### Parameter transforms in init
```
class Product
  init(name, price * 1.2)    note price gets 20% markup automatically

make p Product("Widget", 100)
say p.price                  note 120.0
```

### Methods and self
```
class Counter
  init(count? 0)

  fun increment()
    make self.count + 1

  fun value()
    give self.count

make c Counter()
c.increment()
c.increment()
say c.value()    note 2
```

### Inheritance
```
class Animal
  init(name)

  fun speak()
    give self.name

class Dog(Animal)
  fun speak()
    give super.speak() + " says woof!"

make d Dog("Rex")
say d.speak()      note Rex says woof!
```

`super.methodName()` calls the parent class method.

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

With a credential:
```
post "https://api.example.com/submit" {"key": "value"} use key
```

---

## AI

### ask
Call an AI model. Returns the response as a string.
```
make key "your-api-key"
make result ask gemini "Summarise the history of computing" use key
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

### save / local save
Save to Google Drive (into an `IVX/` folder):
```
save data report.json
save "Hello world" notes.txt
save x               note auto-names file from variable name
```

Save to your local machine instead:
```
local save data report.csv
```

### by
Qualifier used with `wait` to specify the trigger source:
```
wait email by "boss@example.com"
wait sheets "Sales" by "row added"
```

---

## Practical examples

### Hello world
```
say "Hello, world!"
```

### FizzBuzz
```
loop y? < 100
  make y + 1
  if y % 15 = 0 then say "FizzBuzz"
  else if y % 3 = 0 then say "Fizz"
  else if y % 5 = 0 then say "Buzz"
  else say y
```

### Fibonacci
```
make b 1
make n 10
loop y? < n
  say a?
  make temp b
  make b a + b
  make a temp
  make y + 1
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

### Bank account (OOP)
```
class BankAccount
  init(owner, balance? 0)

  fun deposit(amount)
    make self.balance + amount
    say "{self.owner} deposited {amount}"

  fun withdraw(amount)
    if amount > self.balance
      say "Insufficient funds"
    else
      make self.balance - amount
      say "{self.owner} withdrew {amount}"

  fun status()
    say "{self.owner} has ${self.balance}"

make acc BankAccount("Alice", 100)
acc.status()
acc.deposit(50)
acc.withdraw(30)
acc.status()
```

### AI loop
```
make key "your-gemini-key"
use key
make topic "renewable energy"
loop y? < 3
  make result ask gemini "Give me one surprising fact about {topic}"
  say result
  make y + 1
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

### Daily email digest (automated)
```
wait every time "08:00"
  make s sheets "Tasks"
  make tasks s.read("A1:A20")
  make summary ""
  for tasks
    make summary summary + "- {i[0]}\n"
  email "you@example.com" subject "Daily digest" body summary
```

---

## The Lens system

Click the **Lens** button in the editor panel to view your IVX program transpiled into another language.

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
make x 5                     assign
make x + 1                   shorthand reassign
del x                        delete
take x                       input
take int(x)                  input with conversion
say x                        output
give x                       return from function
if cond                      decision
else                         alternate branch
loop cond                    while loop
for list                     iterate
fun name(a, b)               define function
fun name(a, b? 0)            parameter with default
fun name(a, b * 2)           parameter with transform
class Name                   define class
init(a, b)                   constructor — auto-assigns to self
init(a, b? 0)                constructor with default
init(a, b * 2)               constructor with transform
note ...                     comment / block label
ask gemini "..."             AI call
email addr subj body         send email
sheets "Name"                open spreadsheet
save x                       save to Google Drive
local save x                 save to local machine
use key                      set API key
end                          terminate path
wait 5                       pause
wait email by "addr"         wait for email trigger
wait time "09:00"            wait for time trigger
wait every time "09:00"      recurring time trigger
by "source"                  trigger qualifier
```

---

## Zen of IVX

```
Fast is better than slow.
There is no conflict between speed and readability.
Implicit is better than verbose.
Clarity is better than overwork.
Modularity is better than singularity.
But singularity is a foundation for modularity.
Visual clarity is as important as textual clarity.
Flow should be obvious, not hidden.
Programming is ONE language applied to a finite problem space.
Programming languages are not languages, but lenses.
Tooling is part of the language, not an afterthought.
Artificial intelligence is one of those tools.
```
