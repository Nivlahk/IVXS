// ivx-examples.js — Example Programs Panel
// Shows 100 real IVX programs grouped by category.
// Same overlay architecture as ivx-demos.js.
// Depends on: ivx-render.js (srcEl, updateHighlight, scheduleRender)
// Licensed under the Apache License, Version 2.0
// Copyright 2026 IVX

'use strict';

const PROGRAMS = [
  {
        name: "Send a daily email digest from a Google Sheet",
        verdict: "great",
        reviewreduction: 72,
        savings: { python: 70, javascript: 65, typescript: 60, java: 75 },
        analysis: "IVX was built for exactly this: reading a sheet, looping rows, and firing emails — all in native keywords with zero boilerplate.",
        caveats: null,
        ivxcode: `wait every time "08:00"
  make s sheets "Tasks"
  make rows s.read("A1:B50")
  make body ""
  for rows
    make body "{body}- {i[0]}: {i[1]}\n"
  email "you@example.com" subject "Daily digest" body body`
      },
  {
        name: "Read CSV and filter rows by condition",
        verdict: "great",
        reviewreduction: 65,
        savings: { python: 62, javascript: 58, typescript: 54, java: 70 },
        analysis: "take file.csv hands you a list of dicts, where() filters it, and for iterates — three lines of real logic.",
        caveats: null,
        ivxcode: `take file.csv
make filtered where(file, "status", "=", "active")
for row in filtered
  text "{row["name"]} — {row["email"]}"`
      },
  {
        name: "Merge two spreadsheets by a shared key",
        verdict: "great",
        reviewreduction: 68,
        savings: { python: 65, javascript: 60, typescript: 55, java: 72 },
        analysis: "join() is a first-class table builtin. Open two sheets, read ranges, join on key — done in five lines.",
        caveats: null,
        ivxcode: `make s1 sheets "Customers"
make s2 sheets "Orders"
make customers s1.read("A1:C200")
make orders s2.read("A1:D500")
make merged join(customers, orders, "id", "customer_id")
for row in merged
  text "{row["name"]}: {row["total"]}"`
      },
  {
        name: "Watch a sheet for new rows and send welcome email",
        verdict: "great",
        reviewreduction: 75,
        savings: { python: 72, javascript: 68, typescript: 63, java: 78 },
        analysis: "wait sheets with by 'row added' is a first-class trigger. No polling logic, no webhooks — IVX deploys it to Apps Script automatically.",
        caveats: null,
        ivxcode: `wait every sheets "Signups" by "row added"
  make name request[0][0]
  make addr request[0][1]
  email addr subject "Welcome, {name}!" body "Thanks for signing up."`
      },
  {
        name: "Rename and batch-process a list of file records",
        verdict: "good",
        reviewreduction: 48,
        savings: { python: 45, javascript: 40, typescript: 36, java: 52 },
        analysis: "IVX handles the data transformation naturally. Actual filesystem renaming isn't native, but the record manipulation and output is clean.",
        caveats: "No direct filesystem access — output records to Drive or a sheet instead.",
        ivxcode: `make s sheets "Files"
make files s.read("A1:B100")
for file in files
  make oldname file[0]
  make newname lower(replace(oldname, " ", "_"))
  text "Rename: {oldname} → {newname}"
  s.append([oldname, newname, "done"])`
      },
  {
        name: "Auto-reply to emails from a specific sender",
        verdict: "great",
        reviewreduction: 73,
        savings: { python: 70, javascript: 66, typescript: 61, java: 76 },
        analysis: "wait email by address is purpose-built for this. The trigger fires, request has the message, email sends the reply.",
        caveats: null,
        ivxcode: `wait every email by "client@example.com"
  make subject request["subject"]
  make reply "Thanks for your message about: {subject}. We'll respond within 24 hours."
  email "client@example.com" subject "Re: {subject}" body reply`
      },
  {
        name: "Clean and deduplicate a contact list",
        verdict: "great",
        reviewreduction: 62,
        savings: { python: 58, javascript: 54, typescript: 50, java: 65 },
        analysis: "IVX's table builtins — unique(), lower(), trim() — make contact cleaning a pipeline, not a script.",
        caveats: null,
        ivxcode: `take file.csv
make cleaned []
for contact in file
  make email lower(trim(contact["email"]))
  make name trim(contact["name"])
  push(cleaned, {"name": name, "email": email})
make deduped unique(cleaned)
text "Cleaned: {size(deduped)} contacts"
download deduped as contacts_clean.csv`
      },
  {
        name: "FizzBuzz",
        verdict: "great",
        reviewreduction: 60,
        savings: { python: 55, javascript: 50, typescript: 46, java: 65 },
        analysis: "The classic benchmark. IVX's implicit subject in conditions (and % 5 = 0) makes it genuinely shorter than Python.",
        caveats: null,
        ivxcode: `loop n? < 100
  make n + 1
  if n % 15 = 0 then text "FizzBuzz"
  else if n % 3 = 0 then text "Fizz"
  else if n % 5 = 0 then text "Buzz"
  else say n`
      },
  {
        name: "Fibonacci sequence",
        verdict: "good",
        reviewreduction: 52,
        savings: { python: 48, javascript: 44, typescript: 40, java: 58 },
        analysis: "Lazy declaration with ? makes the setup line disappear. The loop body is pure math.",
        caveats: null,
        ivxcode: `make limit 20
make a 0
make b 1
loop n? < limit
  text a
  make temp b
  make b a + b
  make a temp
  make n + 1`
      },
  {
        name: "Prime number sieve",
        verdict: "good",
        reviewreduction: 45,
        savings: { python: 42, javascript: 38, typescript: 34, java: 50 },
        analysis: "Nested loops with IVX's implicit subject shorten the inner condition. The sieve logic maps cleanly.",
        caveats: null,
        ivxcode: `make limit 100
make sieve []
loop i? < limit
  make i + 1
  push(sieve, yes)
make i 2
loop i <= limit
  if sieve[i - 2]
    make j i * 2
    loop j <= limit
      make sieve[j - 2] no
      make j + i
  make i + 1
  text i`
      },
  {
        name: "Calculate compound interest",
        verdict: "great",
        reviewreduction: 58,
        savings: { python: 54, javascript: 50, typescript: 46, java: 62 },
        analysis: "A pure math formula. IVX expresses it in three lines with no ceremony.",
        caveats: null,
        ivxcode: `take flt(principal)
take flt(rate)
take int(years)
make amount principal * (1 + rate / 100) ^ years
text "Principal: {principal}"
text "After {years} years at {rate}%: {amount}"`
      },
  {
        name: "Find duplicates in a list",
        verdict: "great",
        reviewreduction: 62,
        savings: { python: 58, javascript: 54, typescript: 50, java: 66 },
        analysis: "unique() and size() make this a comparison, not a loop. One of IVX's strongest moments.",
        caveats: null,
        ivxcode: `make nums [3, 1, 4, 1, 5, 9, 2, 6, 5, 3]
make seen []
make dupes []
for n in nums
  if n in seen then push(dupes, n)
  else push(seen, n)
make dupes unique(dupes)
text "Duplicates: {dupes}"`
      },
  {
        name: "Count word frequencies in text",
        verdict: "good",
        reviewreduction: 50,
        savings: { python: 46, javascript: 42, typescript: 38, java: 55 },
        analysis: "split() and a dict accumulator are natural. The loop is clean.",
        caveats: null,
        ivxcode: `take text
make words split(lower(text), " ")
make freq {}
for word in words
  make word trim(word)
  if word in freq
    make freq[word] freq[word] + 1
  else
    make freq[word] 1
text freq`
      },
  {
        name: "Sort a list of dicts by multiple keys",
        verdict: "good",
        reviewreduction: 48,
        savings: { python: 44, javascript: 40, typescript: 36, java: 52 },
        analysis: "order() handles single-key sort natively. Multi-key requires a custom sort function, which IVX supports.",
        caveats: null,
        ivxcode: `make people [
  {"name": "Alice", "age": 30, "city": "NY"},
  {"name": "Bob", "age": 25, "city": "LA"},
  {"name": "Carol", "age": 30, "city": "NY"}
]
fun sortKey(a, b)
  if a["city"] != b["city"] then give a["city"] > b["city"]
  give a["age"] > b["age"]
make sorted sort(people, sortKey)
for person in sorted
  text "{person["name"]} — {person["city"]}, {person["age"]}"`
      },
  {
        name: "Group and aggregate sales data",
        verdict: "great",
        reviewreduction: 68,
        savings: { python: 64, javascript: 60, typescript: 56, java: 72 },
        analysis: "group() and agg() are first-class table operations. This is a two-liner in IVX.",
        caveats: null,
        ivxcode: `take file.csv
make grouped group(file, "region")
make totals agg(grouped, "revenue", "sum", "total")
for row in totals
  text "{row["region"]}: {row["total"]}"`
      },
  {
        name: "Binary search",
        verdict: "good",
        reviewreduction: 44,
        savings: { python: 40, javascript: 36, typescript: 32, java: 48 },
        analysis: "IVX handles the loop and index arithmetic cleanly. The logic is readable.",
        caveats: null,
        ivxcode: `fun binarySearch(list, target)
  make lo 0
  make hi size(list) - 1
  loop lo <= hi
    make mid (lo + hi) // 2
    if list[mid] = target then give mid
    else if list[mid] < target then make lo mid + 1
    else make hi mid - 1
  give -1

make nums [1, 3, 5, 7, 9, 11, 13, 15]
take int(target)
make idx binarySearch(nums, target)
if idx >= 0 then text "Found at index {idx}"
else say "Not found"`
      },
  {
        name: "Bubble sort",
        verdict: "partial",
        reviewreduction: 32,
        savings: { python: 28, javascript: 25, typescript: 22, java: 36 },
        analysis: "Nested loops work, but IVX's sort() builtin makes hand-rolling bubble sort feel redundant. Good for demonstration.",
        caveats: "sort() is faster and cleaner for real use.",
        ivxcode: `fun bubbleSort(arr)
  make n size(arr)
  loop i? < n - 1
    make j 0
    loop j < n - i? - 1
      if arr[j] > arr[j + 1]
        make temp arr[j]
        make arr[j] arr[j + 1]
        make arr[j + 1] temp
      make j + 1
    make i + 1
  give arr

make nums [64, 34, 25, 12, 22, 11, 90]
text bubbleSort(nums)`
      },
  {
        name: "Merge sort",
        verdict: "partial",
        reviewreduction: 28,
        savings: { python: 24, javascript: 22, typescript: 18, java: 32 },
        analysis: "Recursive divide-and-conquer works in IVX. The merge step is verbose but correct.",
        caveats: "More lines than Python's equivalent. sort() covers 99% of real needs.",
        ivxcode: `fun merge(left, right)
  make result []
  make i 0
  make j 0
  loop i < size(left) and j < size(right)
    if left[i] <= right[j]
      push(result, left[i])
      make i + 1
    else
      push(result, right[j])
      make j + 1
  loop i < size(left)
    push(result, left[i])
    make i + 1
  loop j < size(right)
    push(result, right[j])
    make j + 1
  give result

fun mergeSort(arr)
  if size(arr) <= 1 then give arr
  make mid size(arr) // 2
  make left mergeSort(head(arr, mid))
  make right mergeSort(drop(arr, mid))
  give merge(left, right)

make nums [38, 27, 43, 3, 9, 82, 10]
text mergeSort(nums)`
      },
  {
        name: "Quicksort",
        verdict: "partial",
        reviewreduction: 30,
        savings: { python: 26, javascript: 23, typescript: 20, java: 34 },
        analysis: "Pivot selection and partition work fine in IVX. Recursion is clean.",
        caveats: "sort() is idiomatic. This is for learning purposes.",
        ivxcode: `fun quickSort(arr)
  if size(arr) <= 1 then give arr
  make pivot arr[size(arr) // 2]
  make left filter(arr, fun(x) then give x < pivot)
  make mid filter(arr, fun(x) then give x = pivot)
  make right filter(arr, fun(x) then give x > pivot)
  give quickSort(left) + mid + quickSort(right)

make nums [3, 6, 8, 10, 1, 2, 1]
text quickSort(nums)`
      },
  {
        name: "Breadth-first graph search",
        verdict: "partial",
        reviewreduction: 28,
        savings: { python: 24, javascript: 20, typescript: 17, java: 32 },
        analysis: "IVX can express BFS with a list as a queue and a dict for the graph. No native graph type, but the logic is clear.",
        caveats: "Graph data structures aren't native — use dicts of lists.",
        ivxcode: `make graph {
  "A": ["B", "C"],
  "B": ["D", "E"],
  "C": ["F"],
  "D": [],
  "E": ["F"],
  "F": []
}
fun bfs(graph, start)
  make visited []
  make queue [start]
  loop size(queue) > 0
    make node queue[0]
    make queue drop(queue, 1)
    if not (node in visited)
      push(visited, node)
      for neighbor in graph[node]
        push(queue, neighbor)
  give visited

text bfs(graph, "A")`
      },
  {
        name: "Depth-first graph search",
        verdict: "partial",
        reviewreduction: 28,
        savings: { python: 24, javascript: 20, typescript: 17, java: 32 },
        analysis: "Recursive DFS is natural. The logic reads cleanly in IVX.",
        caveats: "Same graph-as-dict caveat as BFS.",
        ivxcode: `make graph {
  "A": ["B", "C"],
  "B": ["D", "E"],
  "C": ["F"],
  "D": [],
  "E": ["F"],
  "F": []
}
make visited []
fun dfs(graph, node)
  if node in visited then give none
  push(visited, node)
  for neighbor in graph[node]
    dfs(graph, neighbor)

dfs(graph, "A")
text visited`
      },
  {
        name: "Dijkstra shortest path",
        verdict: "limited",
        reviewreduction: 18,
        savings: { python: 14, javascript: 12, typescript: 10, java: 20 },
        analysis: "Dijkstra needs a priority queue. IVX can simulate one with sort(), but it's awkward without a heap builtin.",
        caveats: "No native priority queue or heap. Performance degrades on large graphs.",
        ivxcode: `make graph {
  "A": {"B": 1, "C": 4},
  "B": {"C": 2, "D": 5},
  "C": {"D": 1},
  "D": {}
}
fun dijkstra(graph, start)
  make dist {"A": 0, "B": 999, "C": 999, "D": 999}
  make unvisited ["A", "B", "C", "D"]
  loop size(unvisited) > 0
    make u first(sort(unvisited, fun(n) then give dist[n]))
    make unvisited filter(unvisited, fun(n) then give n != u)
    for v in keys(graph[u])
      make alt dist[u] + graph[u][v]
      if alt < dist[v] then make dist[v] alt
  give dist

text dijkstra(graph, "A")`
      },
  {
        name: "Detect a cycle in a list",
        verdict: "good",
        reviewreduction: 42,
        savings: { python: 38, javascript: 34, typescript: 30, java: 46 },
        analysis: "Floyd's cycle detection maps naturally to IVX's loop with two index variables.",
        caveats: null,
        ivxcode: `note Floyd's tortoise and hare on a list of next-indices
make nodes [1, 2, 3, 4, 2]  note next[i] values
fun hasCycle(nodes)
  make slow 0
  make fast 0
  loop yes
    make slow nodes[slow]
    make fast nodes[nodes[fast]]
    if slow >= size(nodes) or fast >= size(nodes) then give no
    if slow = fast then give yes
  give no

text hasCycle(nodes)`
      },
  {
        name: "Longest common subsequence",
        verdict: "partial",
        reviewreduction: 26,
        savings: { python: 22, javascript: 19, typescript: 16, java: 30 },
        analysis: "Dynamic programming with a 2D list works in IVX. The table initialization is verbose.",
        caveats: "2D list mutation syntax is slightly clunky.",
        ivxcode: `fun lcs(a, b)
  make m size(a)
  make n size(b)
  make dp []
  loop i? <= m
    make row []
    loop j? <= n
      push(row, 0)
      make j + 1
    push(dp, row)
    make i + 1
  make i 1
  loop i <= m
    make j 1
    loop j <= n
      if a[i-1] = b[j-1]
        make dp[i][j] dp[i-1][j-1] + 1
      else
        make dp[i][j] max(dp[i-1][j], dp[i][j-1])
      make j + 1
    make i + 1
  give dp[m][n]

text lcs("ABCBDAB", "BDCAB")`
      },
  {
        name: "Check if string is a palindrome",
        verdict: "great",
        reviewreduction: 63,
        savings: { python: 58, javascript: 54, typescript: 50, java: 66 },
        analysis: "reverse() on a string comparison. One line of logic.",
        caveats: null,
        ivxcode: `take text
make clean lower(replace(text, " ", ""))
make rev join(reverse(chars(clean)), "")
if clean = rev then text "{text} is a palindrome"
else say "{text} is not a palindrome"`
      },
  {
        name: "Compress a string with run-length encoding",
        verdict: "good",
        reviewreduction: 48,
        savings: { python: 44, javascript: 40, typescript: 36, java: 52 },
        analysis: "Loop over chars with a count accumulator — straightforward.",
        caveats: null,
        ivxcode: `take text
make result ""
make i 0
loop i < size(text)
  make ch text[i]
  make count 1
  loop i + count < size(text) and text[i + count] = ch
    make count + 1
  if count > 1
    make result "{result}{count}{ch}"
  else
    make result "{result}{ch}"
  make i i + count
text result`
      },
  {
        name: "Parse a CSV line respecting quoted fields",
        verdict: "good",
        reviewreduction: 44,
        savings: { python: 40, javascript: 36, typescript: 32, java: 48 },
        analysis: "Character-by-character parsing with a state flag works cleanly in IVX.",
        caveats: null,
        ivxcode: `fun parseCSVLine(line)
  make fields []
  make current ""
  make inQuotes no
  for ch in chars(line)
    if ch = '"'
      make inQuotes not inQuotes
    else if ch = "," and not inQuotes
      push(fields, current)
      make current ""
    else
      make current "{current}{ch}"
  push(fields, current)
  give fields

take line
text parseCSVLine(line)`
      },
  {
        name: "Convert camelCase to snake_case",
        verdict: "good",
        reviewreduction: 52,
        savings: { python: 48, javascript: 44, typescript: 40, java: 56 },
        analysis: "sub() with a regex and lower() handles this cleanly.",
        caveats: null,
        ivxcode: `fun camelToSnake(s)
  make step1 sub(s, "([A-Z]+)([A-Z][a-z])", "$1_$2")
  make step2 sub(step1, "([a-z])([A-Z])", "$1_$2")
  give lower(step2)

take name
text camelToSnake(name)`
      },
  {
        name: "Generate a random password",
        verdict: "great",
        reviewreduction: 60,
        savings: { python: 56, javascript: 52, typescript: 48, java: 64 },
        analysis: "randint, string slicing, and a loop make this compact.",
        caveats: null,
        ivxcode: `make chars "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%"
take int(length)
make password ""
loop i? < length
  make password "{password}{chars[randint(0, size(chars) - 1)]}"
  make i + 1
text password`
      },
  {
        name: "Validate an email address format",
        verdict: "great",
        reviewreduction: 62,
        savings: { python: 58, javascript: 54, typescript: 50, java: 66 },
        analysis: "match() with a regex pattern is a one-liner.",
        caveats: null,
        ivxcode: `fun validEmail(addr)
  give match(addr, "^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$")

take email
if validEmail(email) then text "{email} is valid"
else say "{email} is invalid"`
      },
  {
        name: "Truncate text to N words",
        verdict: "great",
        reviewreduction: 65,
        savings: { python: 60, javascript: 56, typescript: 52, java: 68 },
        analysis: "split(), head(), join() — three builtins, done.",
        caveats: null,
        ivxcode: `take text
take int(n)
make words split(text, " ")
if size(words) > n
  text join(head(words, n), " ") + "..."
else
  text text`
      },
  {
        name: "Compute mean, median, mode",
        verdict: "great",
        reviewreduction: 62,
        savings: { python: 58, javascript: 54, typescript: 50, java: 66 },
        analysis: "IVX's list builtins handle all three. Mean is a reduce, median uses sort, mode uses a freq dict.",
        caveats: null,
        ivxcode: `make nums [4, 1, 2, 2, 3, 5, 2, 4]
make n size(nums)
make mean reduce(nums, fun(a, b) then give a + b, 0) / n
make sorted sort(nums)
make median sorted[n // 2]
make freq {}
for x in nums
  if x in freq then make freq[x] freq[x] + 1
  else make freq[x] 1
make mode first(sort(keys(freq), fun(a, b) then give freq[a] < freq[b]))
text "Mean: {mean}, Median: {median}, Mode: {mode}"`
      },
  {
        name: "Standard deviation of a dataset",
        verdict: "good",
        reviewreduction: 55,
        savings: { python: 50, javascript: 46, typescript: 42, java: 58 },
        analysis: "map() and reduce() express the formula cleanly.",
        caveats: null,
        ivxcode: `make nums [2, 4, 4, 4, 5, 5, 7, 9]
make n size(nums)
make mean reduce(nums, fun(a, b) then give a + b, 0) / n
make diffs map(nums, fun(x) then give (x - mean) ^ 2)
make variance reduce(diffs, fun(a, b) then give a + b, 0) / n
make stddev sqrt(variance)
text "Mean: {mean}, Std dev: {stddev}"`
      },
  {
        name: "Linear regression (slope & intercept)",
        verdict: "good",
        reviewreduction: 50,
        savings: { python: 46, javascript: 42, typescript: 38, java: 54 },
        analysis: "The formula maps directly to IVX math operations.",
        caveats: null,
        ivxcode: `make xs [1, 2, 3, 4, 5]
make ys [2, 4, 5, 4, 5]
make n size(xs)
make sumX reduce(xs, fun(a, b) then give a + b, 0)
make sumY reduce(ys, fun(a, b) then give a + b, 0)
make sumXY reduce(range(n), fun(a, i) then give a + xs[i] * ys[i], 0)
make sumX2 reduce(xs, fun(a, b) then give a + b ^ 2, 0)
make slope (n * sumXY - sumX * sumY) / (n * sumX2 - sumX ^ 2)
make intercept (sumY - slope * sumX) / n
text "y = {slope}x + {intercept}"`
      },
  {
        name: "Matrix multiplication",
        verdict: "good",
        reviewreduction: 44,
        savings: { python: 40, javascript: 36, typescript: 32, java: 48 },
        analysis: "2D list indexing with [row, col] makes matrix math readable.",
        caveats: null,
        ivxcode: `fun matMul(a, b)
  make rowsA rows(a)
  make colsA cols(a)
  make colsB cols(b)
  make result []
  loop i? < rowsA
    make row []
    loop j? < colsB
      make sum 0
      loop k? < colsA
        make sum sum + a[i, k] * b[k, j]
        make k + 1
      push(row, sum)
      make j + 1
    push(result, row)
    make i + 1
  give result

make a [1, 2; 3, 4]
make b [5, 6; 7, 8]
text matMul(a, b)`
      },
  {
        name: "Power set of a list",
        verdict: "good",
        reviewreduction: 46,
        savings: { python: 42, javascript: 38, typescript: 34, java: 50 },
        analysis: "Recursive power set generation works naturally with IVX's list operations.",
        caveats: null,
        ivxcode: `fun powerSet(lst)
  if size(lst) = 0 then give [[]]
  make first lst[0]
  make rest drop(lst, 1)
  make subsets powerSet(rest)
  make withFirst map(subsets, fun(s) then give [first] + s)
  give subsets + withFirst

make items [1, 2, 3]
text powerSet(items)`
      },
  {
        name: "GCD and LCM",
        verdict: "great",
        reviewreduction: 68,
        savings: { python: 62, javascript: 58, typescript: 54, java: 70 },
        analysis: "gcd() and lcm() are native builtins in IVX.",
        caveats: null,
        ivxcode: `take int(a)
take int(b)
text "GCD of {a} and {b}: {gcd(a, b)}"
text "LCM of {a} and {b}: {lcm(a, b)}"`
      },
  {
        name: "Roman numeral to integer",
        verdict: "good",
        reviewreduction: 48,
        savings: { python: 44, javascript: 40, typescript: 36, java: 52 },
        analysis: "A dict lookup and a loop is clean.",
        caveats: null,
        ivxcode: `make vals {"I": 1, "V": 5, "X": 10, "L": 50, "C": 100, "D": 500, "M": 1000}
take roman
make result 0
make i 0
loop i < size(roman)
  make cur vals[roman[i]]
  make nxt 0
  if i + 1 < size(roman) then make nxt vals[roman[i + 1]]
  if cur < nxt
    make result result - cur
  else
    make result result + cur
  make i + 1
text result`
      },
  {
        name: "Integer to Roman numeral",
        verdict: "good",
        reviewreduction: 46,
        savings: { python: 42, javascript: 38, typescript: 34, java: 50 },
        analysis: "A list of value-symbol pairs and a greedy loop.",
        caveats: null,
        ivxcode: `make pairs [
  [1000,"M"],[900,"CM"],[500,"D"],[400,"CD"],
  [100,"C"],[90,"XC"],[50,"L"],[40,"XL"],
  [10,"X"],[9,"IX"],[5,"V"],[4,"IV"],[1,"I"]
]
take int(num)
make result ""
for pair in pairs
  loop num >= pair[0]
    make result "{result}{pair[1]}"
    make num num - pair[0]
text result`
      },
  {
        name: "Bank account with deposit/withdraw/balance",
        verdict: "great",
        reviewreduction: 66,
        savings: { python: 62, javascript: 58, typescript: 54, java: 70 },
        analysis: "IVX classes with init() auto-assign fields. Methods and self are clean.",
        caveats: null,
        ivxcode: `class BankAccount
  init(owner, balance? 0)

  fun deposit(amount)
    make self.balance + amount
    text "{self.owner} deposited {amount}. Balance: {self.balance}"

  fun withdraw(amount)
    if amount > self.balance
      text "Insufficient funds"
    else
      make self.balance - amount
      text "{self.owner} withdrew {amount}. Balance: {self.balance}"

make acc BankAccount("Alice", 500)
acc.deposit(200)
acc.withdraw(100)
acc.withdraw(700)`
      },
  {
        name: "Stack data structure",
        verdict: "great",
        reviewreduction: 68,
        savings: { python: 64, javascript: 60, typescript: 56, java: 72 },
        analysis: "push() and pop() are native. A class wrapping a list is four lines.",
        caveats: null,
        ivxcode: `class Stack
  init(items? [])

  fun push(val)
    push(self.items, val)

  fun pop()
    give pop(self.items)

  fun peek()
    give last(self.items)

  fun isEmpty()
    give size(self.items) = 0

make s Stack()
s.push(1)
s.push(2)
s.push(3)
text s.pop()
text s.peek()`
      },
  {
        name: "Queue data structure",
        verdict: "great",
        reviewreduction: 66,
        savings: { python: 62, javascript: 58, typescript: 54, java: 70 },
        analysis: "A list with push/drop semantics. Wrapping in a class is minimal.",
        caveats: null,
        ivxcode: `class Queue
  init(items? [])

  fun enqueue(val)
    push(self.items, val)

  fun dequeue()
    make val first(self.items)
    make self.items drop(self.items, 1)
    give val

  fun size()
    give size(self.items)

make q Queue()
q.enqueue("first")
q.enqueue("second")
q.enqueue("third")
text q.dequeue()
text q.size()`
      },
  {
        name: "Linked list with append/remove",
        verdict: "partial",
        reviewreduction: 30,
        savings: { python: 26, javascript: 23, typescript: 20, java: 34 },
        analysis: "IVX can represent nodes as dicts and chain them. Traversal is a loop.",
        caveats: "No pointer references — nodes are dict objects chained by key.",
        ivxcode: `class Node
  init(val, next? none)

class LinkedList
  init(head? none)

  fun append(val)
    make node {"val": val, "next": none}
    if self.head = none
      make self.head node
    else
      make cur self.head
      loop cur["next"] != none
        make cur cur["next"]
      make cur["next"] node

  fun toList()
    make result []
    make cur self.head
    loop cur != none
      push(result, cur["val"])
      make cur cur["next"]
    give result

make ll LinkedList()
ll.append(1)
ll.append(2)
ll.append(3)
text ll.toList()`
      },
  {
        name: "Observer pattern",
        verdict: "good",
        reviewreduction: 44,
        savings: { python: 40, javascript: 36, typescript: 32, java: 50 },
        analysis: "Same shape as pub/sub. Classes make it tidy.",
        caveats: null,
        ivxcode: `class Subject
  init(observers? [], state? none)

  fun attach(obs)
    push(self.observers, obs)

  fun setState(val)
    make self.state val
    for obs in self.observers
      obs.update(self.state)

class Logger
  fun update(val) then text "LOG: state changed to {val}"

class Display
  fun update(val) then text "DISPLAY: showing {val}"

make s Subject()
s.attach(Logger())
s.attach(Display())
s.setState(42)
s.setState("hello")`
      },
  {
        name: "Strategy pattern (sorting strategies)",
        verdict: "good",
        reviewreduction: 46,
        savings: { python: 42, javascript: 38, typescript: 34, java: 52 },
        analysis: "Functions are first-class in IVX — pass them as strategies directly.",
        caveats: null,
        ivxcode: `fun ascendingStrategy(a, b) then give a > b
fun descendingStrategy(a, b) then give a < b
fun byLengthStrategy(a, b) then give size(a) > size(b)

class Sorter
  init(strategy)
  fun sort(list)
    give sort(list, self.strategy)

make nums [3, 1, 4, 1, 5, 9, 2, 6]
make s1 Sorter(ascendingStrategy)
make s2 Sorter(descendingStrategy)
text s1.sort(nums)
text s2.sort(nums)

make words ["banana", "fig", "apple", "kiwi"]
make s3 Sorter(byLengthStrategy)
text s3.sort(words)`
      },
  {
        name: "State machine for a traffic light",
        verdict: "great",
        reviewreduction: 60,
        savings: { python: 56, javascript: 52, typescript: 48, java: 64 },
        analysis: "A dict of transitions and a current-state variable. Very clean in IVX.",
        caveats: null,
        ivxcode: `make transitions {
  "red": "green",
  "green": "yellow",
  "yellow": "red"
}
make state "red"
loop i? < 6
  text "Light is: {state}"
  make state transitions[state]
  make i + 1`
      },
  {
        name: "Builder pattern for a query",
        verdict: "good",
        reviewreduction: 46,
        savings: { python: 42, javascript: 38, typescript: 34, java: 52 },
        analysis: "A class with chained methods and a build() step. IVX classes handle this well.",
        caveats: null,
        ivxcode: `class QueryBuilder
  init(table? "", conditions? [], limit? none)

  fun from(t)
    make self.table t
    give self

  fun where(cond)
    push(self.conditions, cond)
    give self

  fun limitTo(n)
    make self.limit n
    give self

  fun build()
    make q "SELECT * FROM {self.table}"
    if size(self.conditions) > 0
      make q "{q} WHERE {join(self.conditions, " AND ")}"
    if self.limit != none
      make q "{q} LIMIT {self.limit}"
    give q

make q QueryBuilder()
text q.from("users").where("age > 18").where("active = 1").limitTo(10).build()`
      },
  {
        name: "Fetch weather data from OpenWeather API",
        verdict: "great",
        reviewreduction: 70,
        savings: { python: 66, javascript: 62, typescript: 58, java: 74 },
        analysis: "A URL string auto-fetches in IVX. String interpolation builds the endpoint. Done.",
        caveats: null,
        ivxcode: `make apiKey "your-openweather-key"
take city
make url "https://api.openweathermap.org/data/2.5/weather?q={city}&appid={apiKey}&units=metric"
make data fetch url
text "{data["name"]}: {data["main"]["temp"]}°C, {data["weather"][0]["description"]}"`
      },
  {
        name: "Post a message to a Slack webhook",
        verdict: "great",
        reviewreduction: 68,
        savings: { python: 64, javascript: 60, typescript: 56, java: 72 },
        analysis: "post keyword handles HTTP POST natively. The webhook body is a dict literal.",
        caveats: null,
        ivxcode: `make webhook "https://hooks.slack.com/services/YOUR/WEBHOOK/URL"
take message
post webhook {"text": message}
text "Posted: {message}"`
      },
  {
        name: "Fetch paginated results from an API",
        verdict: "good",
        reviewreduction: 52,
        savings: { python: 48, javascript: 44, typescript: 40, java: 56 },
        analysis: "A loop that increments the page parameter and breaks on empty results.",
        caveats: null,
        ivxcode: `make allItems []
make page 1
loop yes
  make url "https://api.example.com/items?page={page}&per_page=100"
  make data fetch url
  make items data["items"]
  if size(items) = 0 then end
  for item in items
    push(allItems, item)
  make page + 1
text "Total items: {size(allItems)}"`
      },
  {
        name: "Retry a failing API call with backoff",
        verdict: "good",
        reviewreduction: 50,
        savings: { python: 46, javascript: 42, typescript: 38, java: 54 },
        analysis: "try/err and a loop with wait give you retry logic cleanly.",
        caveats: null,
        ivxcode: `make maxRetries 5
make delay 1
make result none
loop attempt? < maxRetries
  try
    make result fetch "https://api.unreliable.example.com/data"
    end say "Success: {result}"
  err e
    text "Attempt {attempt + 1} failed: {e}. Retrying in {delay}s..."
    wait delay
    make delay delay * 2
  make attempt + 1
text "All retries exhausted"`
      },
  {
        name: "Cache API responses in a dict",
        verdict: "great",
        reviewreduction: 60,
        savings: { python: 56, javascript: 52, typescript: 48, java: 64 },
        analysis: "A dict check before fetching. Trivial in IVX.",
        caveats: null,
        ivxcode: `make cache {}

fun fetchUser(id)
  if id in cache
    text "Cache hit for {id}"
    give cache[id]
  make url "https://api.example.com/users/{id}"
  make data url
  make cache[id] data
  give data

text fetchUser(1)
text fetchUser(2)
text fetchUser(1)  note cache hit`
      },
  {
        name: "Build a simple REST client",
        verdict: "good",
        reviewreduction: 54,
        savings: { python: 50, javascript: 46, typescript: 42, java: 58 },
        analysis: "URL auto-fetch for GET, post for POST. A class wrapping both is clean.",
        caveats: null,
        ivxcode: `class RestClient
  init(baseUrl, token? none)

  fun get(path)
    give fetch "{self.baseUrl}{path}"

  fun post(path, body)
    make url "{self.baseUrl}{path}"
    post url body
    give response

  fun delete(path)
    note IVX has no native DELETE — use post with method override
    make url "{self.baseUrl}{path}"
    post url {"_method": "DELETE"}
    give response

make client RestClient("https://api.example.com", "my-token")
text client.get("/users/1")
client.post("/users", {"name": "Alice", "email": "alice@example.com"})`
      },
  {
        name: "Summarise a long document with AI",
        verdict: "great",
        reviewreduction: 74,
        savings: { python: 70, javascript: 66, typescript: 62, java: 78 },
        analysis: "ask gemini with a prompt string is one line. IVX has native AI built in.",
        caveats: null,
        ivxcode: `key "your-gemini-key"
take file.txt
make summary ask gemini "Summarise this document in 3 bullet points:\n\n{file}"
text summary`
      },
  {
        name: "Classify support tickets by category",
        verdict: "great",
        reviewreduction: 72,
        savings: { python: 68, javascript: 64, typescript: 60, java: 76 },
        analysis: "Loop over tickets, ask the model, write results to a sheet. Pure IVX.",
        caveats: null,
        ivxcode: `key "your-gemini-key"
make s sheets "Tickets"
make tickets s.read("A1:B200")
for ticket in tickets
  make id ticket[0]
  make text ticket[1]
  make category ask gemini "Classify this support ticket into one of: billing, technical, general. Reply with just the category.\n\nTicket: {text}"
  s.append([id, text, category])
text "Done classifying {size(tickets)} tickets"`
      },
  {
        name: "Extract entities from text",
        verdict: "great",
        reviewreduction: 70,
        savings: { python: 66, javascript: 62, typescript: 58, java: 74 },
        analysis: "ask with a structured prompt, parse the result. Native in IVX.",
        caveats: null,
        ivxcode: `key "your-gemini-key"
take text
make result ask gemini "Extract all people, places, and organisations from this text. Format as JSON.\n\n{text}"
text result`
      },
  {
        name: "Answer questions about a CSV dataset",
        verdict: "great",
        reviewreduction: 72,
        savings: { python: 68, javascript: 64, typescript: 60, java: 76 },
        analysis: "Load the CSV, format it as context, feed to AI. IVX does this naturally.",
        caveats: null,
        ivxcode: `key "your-gemini-key"
take file.csv
make context str(file)
loop question? != "quit"
  take question
  if question = "quit" then end
  make answer ask gemini "Answer this question about the dataset below.\n\nDataset:\n{context}\n\nQuestion: {question}"
  text answer`
      },
  {
        name: "Rewrite text to a different reading level",
        verdict: "great",
        reviewreduction: 70,
        savings: { python: 66, javascript: 62, typescript: 58, java: 74 },
        analysis: "One ask call with a clear prompt. Done.",
        caveats: null,
        ivxcode: `key "your-gemini-key"
take text
take level  note e.g. "5th grade", "academic", "simple"
make rewritten ask gemini "Rewrite the following text for a {level} reading level. Keep the meaning identical.\n\n{text}"
text rewritten`
      },
  {
        name: "Auto-tag emails by topic",
        verdict: "great",
        reviewreduction: 73,
        savings: { python: 69, javascript: 65, typescript: 61, java: 77 },
        analysis: "wait email + ask gemini + s.append is the whole program.",
        caveats: null,
        ivxcode: `key "your-gemini-key"
make s sheets "Email Tags"
wait every email by "inbox@example.com"
  make subject request["subject"]
  make body request["body"]
  make tag ask gemini "Tag this email with one of: sales, support, spam, internal, other. Reply with just the tag.\n\nSubject: {subject}\nBody: {body}"
  s.append([subject, tag, now()])`
      },
  {
        name: "Guessing number game",
        verdict: "great",
        reviewreduction: 68,
        savings: { python: 64, javascript: 60, typescript: 56, java: 72 },
        analysis: "The canonical IVX example. Lazy declaration, loop, implicit subject in conditions.",
        caveats: null,
        ivxcode: `make secret randint(1, 100)
text "Guess a number between 1 and 100!"
loop guess? != secret
  take int(guess)
  make tries? + 1
  if guess < secret then text "Too low!"
  else if guess > secret then text "Too high!"
text "Correct in {tries} tries!"`
      },
  {
        name: "Rock paper scissors vs computer",
        verdict: "great",
        reviewreduction: 65,
        savings: { python: 60, javascript: 56, typescript: 52, java: 68 },
        analysis: "A wins dict, randint for the computer, string interpolation for output. All native.",
        caveats: null,
        ivxcode: `make options ["rock", "paper", "scissors"]
make wins {"rock": "scissors", "scissors": "paper", "paper": "rock"}
loop yes
  take player
  if player = "quit" then end
  make computer options[randint(0, 2)]
  text "Computer chose: {computer}"
  if player = computer then text "Draw!"
  else if wins[player] = computer then text "You win!"
  else say "Computer wins!"`
      },
  {
        name: "Simple quiz with scoring",
        verdict: "great",
        reviewreduction: 66,
        savings: { python: 62, javascript: 58, typescript: 54, java: 70 },
        analysis: "A list of dicts, a loop, string comparison. Totally natural.",
        caveats: null,
        ivxcode: `make questions [
  {"q": "Capital of France?", "a": "paris"},
  {"q": "2 + 2?", "a": "4"},
  {"q": "Largest planet?", "a": "jupiter"},
  {"q": "Speed of light unit?", "a": "c"}
]
make score 0
for q in questions
  text q["q"]
  take answer
  if lower(answer) = q["a"]
    text "Correct!"
    make score + 1
  else
    text "Wrong! Answer: {q["a"]}"
text "Score: {score}/{size(questions)}"`
      },
  {
        name: "Hangman game",
        verdict: "good",
        reviewreduction: 50,
        savings: { python: 46, javascript: 42, typescript: 38, java: 54 },
        analysis: "String manipulation and a loop with state. Works cleanly in IVX.",
        caveats: null,
        ivxcode: `make word "hangman"
make guessed []
make lives 6
loop lives > 0
  make display ""
  for ch in chars(word)
    if ch in guessed then make display "{display}{ch}"
    else make display "{display}_"
  text display
  if not ("_" in display) then end say "You win!"
  text "Lives: {lives} | Guessed: {guessed}"
  take letter
  if letter in guessed then text "Already guessed!"
  else if letter in word
    push(guessed, letter)
    text "Correct!"
  else
    push(guessed, letter)
    make lives - 1
    text "Wrong!"
text "Game over! Word was: {word}"`
      },
  {
        name: "Blackjack hand evaluator",
        verdict: "good",
        reviewreduction: 48,
        savings: { python: 44, javascript: 40, typescript: 36, java: 52 },
        analysis: "A value dict, a sum loop with ace handling. Logic is clean.",
        caveats: null,
        ivxcode: `make values {"2":2,"3":3,"4":4,"5":5,"6":6,"7":7,"8":8,"9":9,"10":10,"J":10,"Q":10,"K":10,"A":11}
fun handValue(hand)
  make total 0
  make aces 0
  for card in hand
    make total total + values[card]
    if card = "A" then make aces + 1
  loop total > 21 and aces > 0
    make total - 10
    make aces - 1
  give total

make hand ["A", "K"]
text "Hand: {hand} = {handValue(hand)}"
make hand2 ["A", "A", "9"]
text "Hand: {hand2} = {handValue(hand2)}"`
      },
  {
        name: "Conway Game of Life (step)",
        verdict: "partial",
        reviewreduction: 32,
        savings: { python: 28, javascript: 25, typescript: 22, java: 36 },
        analysis: "2D list iteration works. Neighbour counting is index arithmetic in a nested loop.",
        caveats: "No terminal rendering — output is a list of lists. Needs a UI layer for visual display.",
        ivxcode: `fun step(grid)
  make r rows(grid)
  make c cols(grid)
  make next []
  loop i? < r
    make row []
    loop j? < c
      make neighbors 0
      loop di? < 3
        loop dj? < 3
          if di != 1 or dj != 1
            make ni i + di - 1
            make nj j + dj - 1
            if ni >= 0 and ni < r and nj >= 0 and nj < c
              make neighbors neighbors + grid[ni, nj]
          make dj + 1
        make di + 1
      make alive grid[i, j]
      if alive = 1 and (neighbors = 2 or neighbors = 3) then push(row, 1)
      else if alive = 0 and neighbors = 3 then push(row, 1)
      else push(row, 0)
      make j + 1
    push(next, row)
    make i + 1
  give next

make grid [0,1,0; 0,0,1; 1,1,1]
text step(grid)`
      },
  {
        name: "Monte Carlo pi estimation",
        verdict: "good",
        reviewreduction: 55,
        savings: { python: 50, javascript: 46, typescript: 42, java: 58 },
        analysis: "random(), a loop, basic math. Six lines.",
        caveats: null,
        ivxcode: `make samples 100000
make inside 0
loop i? < samples
  make x random() * 2 - 1
  make y random() * 2 - 1
  if x ^ 2 + y ^ 2 <= 1
    make inside + 1
  make i + 1
make pi 4 * inside / samples
text "Estimated π: {pi}"`
      },
  {
        name: "Unit converter (km to miles etc)",
        verdict: "great",
        reviewreduction: 65,
        savings: { python: 60, javascript: 56, typescript: 52, java: 68 },
        analysis: "A dict of conversion factors and a lookup. Three lines of logic.",
        caveats: null,
        ivxcode: `make conversions {
  "km_to_miles": 0.621371,
  "miles_to_km": 1.60934,
  "kg_to_lbs": 2.20462,
  "lbs_to_kg": 0.453592,
  "c_to_f": none,
  "f_to_c": none
}
take flt(value)
take conversion
if conversion = "c_to_f"
  text "{value}°C = {value * 9/5 + 32}°F"
else if conversion = "f_to_c"
  text "{value}°F = {(value - 32) * 5/9}°C"
else
  text "{value} {conversion} = {value * conversions[conversion]}"`
      },
  {
        name: "Loan repayment schedule",
        verdict: "good",
        reviewreduction: 54,
        savings: { python: 50, javascript: 46, typescript: 42, java: 58 },
        analysis: "Standard amortisation formula in a loop. IVX handles the math cleanly.",
        caveats: null,
        ivxcode: `take flt(principal)
take flt(annualRate)
take int(months)
make monthlyRate annualRate / 100 / 12
make payment principal * monthlyRate * (1 + monthlyRate) ^ months / ((1 + monthlyRate) ^ months - 1)
make balance principal
loop i? < months
  make interest balance * monthlyRate
  make principalPart payment - interest
  make balance balance - principalPart
  make i + 1
  text "Month {i}: payment {round(payment)}, interest {round(interest)}, balance {round(balance)}"`
      },
  {
        name: "Tax bracket calculator",
        verdict: "good",
        reviewreduction: 52,
        savings: { python: 48, javascript: 44, typescript: 40, java: 56 },
        analysis: "A list of bracket thresholds and a loop. Clean.",
        caveats: null,
        ivxcode: `make brackets [
  [10275, 0.10],
  [41775, 0.12],
  [89075, 0.22],
  [170050, 0.24],
  [215950, 0.32],
  [539900, 0.35],
  [999999999, 0.37]
]
take flt(income)
make tax 0
make prev 0
for bracket in brackets
  make limit bracket[0]
  make rate bracket[1]
  if income <= limit
    make tax tax + (income - prev) * rate
    end say "Income: {income}, Tax: {round(tax)}, Effective rate: {round(tax/income*100)}%"
  make tax tax + (limit - prev) * rate
  make prev limit`
      },
  {
        name: "Password strength checker",
        verdict: "great",
        reviewreduction: 62,
        savings: { python: 58, javascript: 54, typescript: 50, java: 66 },
        analysis: "match() calls and size checks. Very readable.",
        caveats: null,
        ivxcode: `take password
make score 0
make feedback []
if size(password) >= 8
  make score + 1
else
  push(feedback, "Use at least 8 characters")
if match(password, "[A-Z]") then make score + 1
else push(feedback, "Add uppercase letters")
if match(password, "[a-z]") then make score + 1
else push(feedback, "Add lowercase letters")
if match(password, "[0-9]") then make score + 1
else push(feedback, "Add numbers")
if match(password, "[^a-zA-Z0-9]") then make score + 1
else push(feedback, "Add special characters")
make strength ["Weak","Fair","Good","Strong","Very Strong"][score - 1]
text "Strength: {strength}"
for tip in feedback then text "  → {tip}"`
      },
  {
        name: "To-do list (add/complete/delete)",
        verdict: "great",
        reviewreduction: 64,
        savings: { python: 60, javascript: 56, typescript: 52, java: 68 },
        analysis: "A list of dicts, a command loop, string matching. All native IVX.",
        caveats: null,
        ivxcode: `make todos []
make nextId 1
loop yes
  text "Commands: add, complete, delete, list, quit"
  take cmd
  if cmd = "quit" then end
  if cmd = "add"
    take task
    push(todos, {"id": nextId, "task": task, "done": no})
    make nextId + 1
  else if cmd = "complete"
    take int(id)
    for todo in todos
      if todo["id"] = id then make todo["done"] yes
  else if cmd = "delete"
    take int(id)
    make todos filter(todos, fun(t) then give t["id"] != id)
  else if cmd = "list"
    for todo in todos
      make mark "[ ]"
      if todo["done"] then make mark "[x]"
      text "{mark} {todo["id"]}. {todo["task"]}"`
      },
  {
        name: "Budget tracker (income/expense/balance)",
        verdict: "great",
        reviewreduction: 65,
        savings: { python: 61, javascript: 57, typescript: 53, java: 69 },
        analysis: "A running balance, a transaction list, string matching on type. Very natural.",
        caveats: null,
        ivxcode: `make transactions []
make balance 0
loop yes
  text "Balance: {balance} | Commands: income, expense, history, quit"
  take cmd
  if cmd = "quit" then end
  if cmd = "income" or cmd = "expense"
    take flt(amount)
    take desc
    if cmd = "income"
      make balance + amount
      push(transactions, {"+": amount, "desc": desc})
    else
      make balance - amount
      push(transactions, {"-": amount, "desc": desc})
  else if cmd = "history"
    for t in transactions
      if "+" in t then text "+ {t["+"]}: {t["desc"]}"
      else say "- {t["-"]}: {t["desc"]}"`
      },
  {
        name: "Countdown to a future date",
        verdict: "great",
        reviewreduction: 67,
        savings: { python: 63, javascript: 59, typescript: 55, java: 70 },
        analysis: "datediff() is a native builtin. now() gives today. Done in three lines.",
        caveats: null,
        ivxcode: `take targetDate  note format: YYYY-MM-DD
make today now()
make days datediff(today, targetDate, "days")
make hours datediff(today, targetDate, "hours")
if days > 0
  text "{days} days ({hours} hours) until {targetDate}"
else if days = 0
  text "Today is the day!"
else
  text "{targetDate} was {abs(days)} days ago"`
      }
];
// ── Category definitions ──────────────────────────────────────────────────────
const IVX_EXAMPLE_SECTIONS = [
  { label: 'Automation',   category: 'Automation & scripting' },
  { label: 'Data',         category: 'Data processing' },
  { label: 'Algorithms',   category: 'Algorithms' },
  { label: 'Strings',      category: 'String processing' },
  { label: 'Math',         category: 'Math & statistics' },
  { label: 'OOP',          category: 'OOP & design patterns' },
  { label: 'APIs',         category: 'APIs & integration' },
  { label: 'AI',           category: 'AI tasks' },
  { label: 'Games',        category: 'Games & simulation' },
  { label: 'Tools',        category: 'Practical tools' },
];

// Attach category to each program by scanning the order they appear
// (categories are contiguous blocks in the PROGRAMS array)
(function tagPrograms() {
  // Actual counts from the benchmark source, in order
  const blocks = [
    { cat: 'Automation & scripting', count: 10 },
    { cat: 'Data processing',        count: 10 },
    { cat: 'Algorithms',             count: 10 },
    { cat: 'String processing',      count: 10 },
    { cat: 'Math & statistics',      count: 10 },
    { cat: 'OOP & design patterns',  count: 10 },
    { cat: 'APIs & integration',     count: 10 },
    { cat: 'AI tasks',               count: 10 },
    { cat: 'Games & simulation',     count: 10 },
    { cat: 'Practical tools',        count: 10 },
  ];
  let idx = 0;
  blocks.forEach(({ cat, count }) => {
    for (let i = 0; i < count && idx < PROGRAMS.length; i++, idx++) {
      PROGRAMS[idx]._category = cat;
    }
  });
  // Any overflow gets the last category
  while (idx < PROGRAMS.length) {
    PROGRAMS[idx]._category = 'Practical tools';
    idx++;
  }
})();

// ── Verdict colours ───────────────────────────────────────────────────────────
const VERDICT_COLOR = {
  great:   '#00e5a0',
  good:    '#4a7fff',
  partial: '#f0a030',
  limited: '#e05050',
};

const VERDICT_LABEL = {
  great:   'great fit',
  good:    'good fit',
  partial: 'partial',
  limited: 'limited',
};

// ── Panel state ───────────────────────────────────────────────────────────────
let _exPanel = null;
let _exCurrentIdx = 0;
let _exCurrentCategory = 'Automation & scripting';

// ── Helpers ───────────────────────────────────────────────────────────────────
function _exEsc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function _exProgramsForCategory(cat) {
  return PROGRAMS.filter(p => p._category === cat);
}

// ── Build panel DOM (once) ────────────────────────────────────────────────────
function _buildExPanel() {
  const panel = document.createElement('div');
  panel.id = 'ivx-ex-panel';

  // ── Sidebar ──────────────────────────────────────────────────────────────
  const sidebar = document.createElement('div');
  sidebar.id = 'ivx-ex-sidebar';

  IVX_EXAMPLE_SECTIONS.forEach(sec => {
    const secEl = document.createElement('div');
    secEl.className = 'ivx-ex-section';

    const lbl = document.createElement('div');
    lbl.className = 'ivx-ex-section-label';
    lbl.textContent = sec.label;
    secEl.appendChild(lbl);

    const progs = _exProgramsForCategory(sec.category);
    progs.forEach((prog, localIdx) => {
      const globalIdx = PROGRAMS.indexOf(prog);
      const btn = document.createElement('button');
      btn.className = 'ivx-ex-prog-btn';
      btn.dataset.exIdx = globalIdx;
      btn.textContent = prog.name;
      btn.title = prog.name;

      const dot = document.createElement('span');
      dot.className = 'ivx-ex-verdict-dot';
      dot.style.background = VERDICT_COLOR[prog.verdict] || '#6b7280';
      btn.prepend(dot);

      btn.addEventListener('click', () => _selectExample(globalIdx));
      secEl.appendChild(btn);
    });

    sidebar.appendChild(secEl);
  });

  // ── Main area ─────────────────────────────────────────────────────────────
  const main = document.createElement('div');
  main.id = 'ivx-ex-main';

  // Header
  const hdr = document.createElement('div');
  hdr.id = 'ivx-ex-hdr';

  const titleEl = document.createElement('span');
  titleEl.id = 'ivx-ex-title';

  const verdictEl = document.createElement('span');
  verdictEl.id = 'ivx-ex-verdict';

  const sep = document.createElement('span');
  sep.id = 'ivx-ex-sep';

  const analysisEl = document.createElement('span');
  analysisEl.id = 'ivx-ex-analysis';

  const loadBtn = document.createElement('button');
  loadBtn.id = 'ivx-ex-load';
  loadBtn.textContent = '← load into editor';
  loadBtn.title = 'Replace editor contents with this program';
  loadBtn.addEventListener('click', _loadExample);

  hdr.append(titleEl, verdictEl, sep, analysisEl, loadBtn);

  // Code viewport
  const viewport = document.createElement('div');
  viewport.id = 'ivx-ex-viewport';

  const pre = document.createElement('pre');
  pre.id = 'ivx-ex-code';
  viewport.appendChild(pre);

  // Caveats bar (shown when relevant)
  const caveatsEl = document.createElement('div');
  caveatsEl.id = 'ivx-ex-caveats';

  main.append(hdr, viewport, caveatsEl);
  panel.append(sidebar, main);
  return panel;
}

// ── Render a program into the main area ───────────────────────────────────────
function _renderExample(idx) {
  const prog = PROGRAMS[idx];
  if (!prog) return;
  _exCurrentIdx = idx;

  const titleEl    = document.getElementById('ivx-ex-title');
  const verdictEl  = document.getElementById('ivx-ex-verdict');
  const analysisEl = document.getElementById('ivx-ex-analysis');
  const codeEl     = document.getElementById('ivx-ex-code');
  const caveatsEl  = document.getElementById('ivx-ex-caveats');

  if (titleEl) titleEl.textContent = prog.name;

  if (verdictEl) {
    verdictEl.textContent = VERDICT_LABEL[prog.verdict] || prog.verdict;
    verdictEl.style.color = VERDICT_COLOR[prog.verdict] || '#6b7280';
    verdictEl.style.borderColor = VERDICT_COLOR[prog.verdict] || '#6b7280';
  }

  if (analysisEl) analysisEl.textContent = prog.analysis || '';
  if (codeEl)     codeEl.textContent = prog.ivxcode || '';

  if (caveatsEl) {
    if (prog.caveats) {
      caveatsEl.style.display = 'block';
      caveatsEl.textContent = '⚠ ' + prog.caveats;
    } else {
      caveatsEl.style.display = 'none';
    }
  }

  // Update sidebar active state
  document.querySelectorAll('.ivx-ex-prog-btn').forEach(btn => {
    const active = Number(btn.dataset.exIdx) === idx;
    btn.classList.toggle('ivx-ex-prog-btn--active', active);
  });

  // Scroll sidebar button into view
  const activeBtn = document.querySelector(`.ivx-ex-prog-btn[data-ex-idx="${idx}"]`);
  if (activeBtn) activeBtn.scrollIntoView({ block: 'nearest' });
}

function _selectExample(idx) {
  _renderExample(idx);
}

function _loadExample() {
  const prog = PROGRAMS[_exCurrentIdx];
  if (!prog || typeof srcEl === 'undefined') return;
  if (srcEl.value.trim() && !confirm('Replace current editor contents with this example?')) return;
  srcEl.value = prog.ivxcode;
  if (typeof updateHighlight === 'function') updateHighlight();
  if (typeof scheduleRender  === 'function') scheduleRender();
  _closeExPanel();
}

// ── Open / close ──────────────────────────────────────────────────────────────
function _openExPanel() {
  if (!_exPanel) {
    _exPanel = _buildExPanel();
    document.getElementById('ep').appendChild(_exPanel);
  }
  _exPanel.style.display = 'flex';
  _renderExample(_exCurrentIdx);
}

function _closeExPanel() {
  if (_exPanel) _exPanel.style.display = 'none';
}

function _toggleExPanel() {
  if (!_exPanel || _exPanel.style.display === 'none') _openExPanel();
  else _closeExPanel();
}

// ── Wire up an "Examples" button next to Keywords ─────────────────────────────
window.addEventListener('load', function initExPanel() {
  const kwBtn = document.getElementById('help-menu-btn');
  if (!kwBtn) return;

  const exBtn = document.createElement('button');
  exBtn.id = 'ex-panel-btn';
  exBtn.className = 'kb panel-hdr-btn';
  exBtn.textContent = 'Examples';

  // Insert after the Keywords button
  kwBtn.parentNode.insertBefore(exBtn, kwBtn.nextSibling);

  exBtn.addEventListener('click', e => {
    e.stopPropagation();
    _toggleExPanel();
    exBtn.classList.toggle('on', _exPanel?.style.display !== 'none');
  });

  // Close on outside click
  document.addEventListener('click', e => {
    if (_exPanel && _exPanel.style.display !== 'none') {
      if (!_exPanel.contains(e.target) && e.target !== exBtn) {
        _closeExPanel();
        exBtn.classList.remove('on');
      }
    }
  });
});
