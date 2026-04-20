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

### try / err
Catch runtime errors and handle them gracefully.
```
try
  make data "https://api.example.com/data"
  say data
err e
  say "Failed: {e}"

say "program continues"
```

The variable after `err` holds the error message. Execution continues after the try/err block regardless of whether an error occurred.

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

Inline with `then`:
```
fun double(x) then give x * 2
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

### Higher-order functions
Pass named functions to builtins like `map`, `filter`, and `reduce`:
```
fun double(x) then give x * 2
fun isEven(x) then give x % 2 = 0

make nums [1, 2, 3, 4, 5]
say map(nums, double)      note [2, 4, 6, 8, 10]
say filter(nums, isEven)   note [2, 4]
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
Any bare URL starting with `https://` auto-fetches when evaluated:
```
make data https://jsonplaceholder.typicode.com/todos/1
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
post "https://api.example.com/submit" {"key": "value"} key mykey
```

### Imports
Fetch and run an IVX module from a URL, importing named functions:
```
from https://ivxs.tech/std/strings use slugify, truncate
say slugify("Hello World")
```

---

## AI

### ask
Call an AI model. Returns the response as a string.
```
make k "your-api-key"
key k
make result ask gemini "Summarise the history of computing"
say result
```

| Model | Keyword | Free? |
|-------|---------|-------|
| Google Gemini 2.5 Flash | `gemini` or `google` | Yes — via AI Studio |
| OpenAI GPT-4o Mini | `chatgpt` or `gpt` | No |
| Anthropic Claude Haiku | `claude` or `anthropic` | No |

### key
Set a global credential for AI and API calls.
```
key "your-api-key"
```

Inline (this call only):
```
make result ask gemini "Hello" key "your-key"
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

## Built-in functions

### Type conversion
```
int(x)       note to integer
flt(x)       note to float
str(x)       note to string
bin(x)       note to boolean
list(x)      note to list
dict(x)      note to dict
```

### Math
```
abs(x)          round(x)        floor(x)       ceil(x)
min(a, b)       max(a, b)       sqrt(x)
```

### String
```
upper(s)                       note "hello" → "HELLO"
lower(s)                       note "HELLO" → "hello"
trim(s)                        note remove whitespace
split(s, sep)                  note "a,b,c" → ["a","b","c"]
join(list, sep)                note ["a","b"] → "a,b"
replace(s, from, to)           note replace all occurrences
contains(s, sub)               note yes/no
starts(s, prefix)              note yes/no
ends(s, suffix)                note yes/no
index(s, sub)                  note position, or none if not found
slice(s, start, end)           note substring
pad(s, len, char)              note left-pad to length
padend(s, len, char)           note right-pad to length
chars(s)                       note string to list of characters
repeat(s, n)                   note repeat string n times
size(x)                        note length of string, list, or dict
length(x)                      note alias for size
```

### List
```
push(list, val)                note add to end (mutates)
pop(list)                      note remove from end (mutates)
sort(list)                     note sorted copy
sort(list, fun)                note sorted by custom function
reverse(list)                  note reversed copy
unique(list)                   note remove duplicates
flat(list)                     note flatten one level
first(list)                    note first element
last(list)                     note last element
head(list, n)                  note first n elements
drop(list, n)                  note skip first n elements
zip(a, b)                      note [[a0,b0], [a1,b1], ...]
map(list, fun)                 note transform each element
filter(list, fun)              note keep matching elements
reduce(list, fun, init)        note fold to single value
```

### 2D list
```
rows(grid)                     note number of rows
cols(grid)                     note number of columns
row(grid, n)                   note nth row as list
col(grid, n)                   note nth column as list
transpose(grid)                note flip rows and columns
colnames(table)                note column names from dict table
```

### Table (list of dicts)
```
where(table, col, op, value)   note filter rows
order(table, col, dir)         note sort rows ("asc" or "desc")
group(table, cols)             note group by column(s)
agg(grouped, col, fn, as)      note aggregate (sum/avg/count/min/max)
join(left, right, lcol, rcol)  note inner join two tables
```

### Date / time
```
now()                          note today's date as "YYYY-MM-DD"
time()                         note current time as "HH:mm:ss"
timestamp()                    note milliseconds since epoch
year(date)                     note extract year
month(date)                    note extract month (1-12)
day(date)                      note extract day of month
hour(date)                     note extract hour
minute(date)                   note extract minute
weekday(date)                  note "Monday", "Tuesday", etc.
dateadd(date, n, unit)         note add days/months/years/hours/minutes
datediff(d1, d2, unit)         note difference in days/months/years etc.
format(date, pattern)          note "YYYY-MM-DD HH:mm:ss dddd"
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

### List processing
```
make nums [3, 1, 4, 1, 5, 9, 2, 6]
say sort(nums)
say unique(nums)
say reverse(nums)

fun double(x) then give x * 2
fun isOdd(x) then give x % 2 != 0

say map(nums, double)
say filter(nums, isOdd)
```

### 2D list
```
make grid [1, 2, 3; 4, 5, 6; 7, 8, 9]
say rows(grid)          note 3
say col(grid, 0)        note [1, 4, 7]
say transpose(grid)
```

### Error handling
```
try
  make result "https://api.example.com/data"
  say result
err e
  say "Request failed: {e}"
  make result none
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

### Date calculations
```
make today now()
say "Today is {weekday(today)}, {today}"
say dateadd(today, 30, "days")
say datediff("2026-01-01", today, "days")
```

### AI loop
```
key "your-gemini-key"
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

### Import a module
```
from https://ivxs.tech/std/math use fibonacci
say fibonacci(10)
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
fun name(x) then give x * 2  inline function
class Name                   define class
init(a, b)                   constructor — auto-assigns to self
init(a, b? 0)                constructor with default
init(a, b * 2)               constructor with transform
try / err e                  error handling
note ...                     comment / block label
ask gemini "..."             AI call
key "..."                    set global credential
from URL use name            import from URL
email addr subj body         send email
sheets "Name"                open spreadsheet
save x                       save to Google Drive
local save x                 save to local machine
end                          terminate path
wait 5                       pause
wait email by "addr"         wait for email trigger
wait time "09:00"            wait for time trigger
wait every time "09:00"      recurring time trigger
by "source"                  trigger qualifier
now()  time()  weekday()     date and time
sort() filter() map()        list operations
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
