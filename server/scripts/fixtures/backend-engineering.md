# Chapter 5 — Backends Under Load

## 5.1 A promise is a fraction of a month

A backend is the part of a system that accepts a request, does the work, and sends a response. The work is ordinary: read a row, write a charge, ask three other services, return JSON. What makes it engineering is that the same work has to happen for many requests at once, inside a deadline, without lying to the caller.

The promise made to callers is usually a percentage. "99.9% of requests succeed" sounds like a rounding of "99%". It is not. Take a 30-day month, which has

    30 × 24 × 60 = 43,200 minutes

The allowed failure is the slice of that month you are permitted to miss.

    99%    allows 1%    of 43,200 = 432 minutes, which is 7.2 hours
    99.5%  allows 0.5%  of 43,200 = 216 minutes
    99.9%  allows 0.1%  of 43,200 = 43.2 minutes
    99.99% allows 0.01% of 43,200 = 4.32 minutes

**The gap between 99% and 99.9% is a factor of ten, not a coat of polish.** 216 / 43.2 = 5, so a month that actually ran at 99.5% has already burned five times the entire budget of a 99.9% promise. A student who says "99.5% is basically three nines" is off by that factor of five.

The budget is spent by the clock, not by how reasonable the incident felt. If 40 of the 43.2 minutes are already gone, 3.2 minutes remain. A deploy that errors for 10 minutes does not fit in what is left, however small the code change was. Every later section in this chapter is a way of spending those minutes by accident: a queue that grows, a page that waits on its slowest call, a cache that stops protecting the database, a retry that multiplies a failure, a door that cannot tell a burst from a flood.

## 5.2 How many requests fit in the building

While a system is keeping up, the average number of requests inside it is fixed by Little's law:

    inFlight = arrivalPerSec × timeInSystemSec

arrivalPerSec is how many requests arrive each second, and timeInSystemSec is how long each one stays, queue included. The law is about those averages. It does not, by itself, say whether the wait will grow. It says that a measured wait and a measured arrival determine how many requests you are holding.

Worked example, one worker. A worker takes 0.1 s of uninterrupted effort to finish one request, and it does one at a time. Random arrivals come at 8 per second. The worker's utilisation is

    U = arrivalPerSec × serviceSec = 8 × 0.1 = 0.8

For this single worker, when arrivals come as a Poisson process and the service time varies around that 0.1 s mean, the average time in the system is

    timeInSystemSec = serviceSec / (1 − U) = 0.1 / 0.2 = 0.5 s

Little's law then says inFlight = 8 × 0.5 = 4. Raise the arrival from 8 to 9 per second. Utilisation becomes 0.9, time in the system becomes 0.1 / 0.1 = 1.0 s, and inFlight = 9 × 1.0 = 9. Arrival rose by 1/8, which is 12.5%. Time in the system doubled. A student who says "a little more traffic means a little more latency" is using a proportion the queue does not have. As utilisation approaches 1, the wait grows without a matching growth in the work.

The hard ceiling is simpler, and it needs no arrival model. A worker that spends serviceSec on each request, and N such workers, can finish at most

    capacityPerSec = workers / serviceSec

requests per second. Past that, arrivals are not slowed politely. They pile up. With 4 workers and serviceSec = 0.1, capacity is 4 / 0.1 = 40 per second. An arrival of 50 per second is 10 more than capacity, so the queue grows by 10 requests every second. After 30 s, 300 requests are waiting that nobody is serving. Adding "just a bit" of traffic once you are already over capacity does not add a bit of latency. It adds a queue that lengthens for as long as the flood continues.

**If arrivals exceed capacity, the queue grows by the difference every second, and it does not settle.** Capacity here counts the whole time a worker is occupied, including the time it spends blocked, waiting on another service. A profiler that says the CPU work is 0.05 s is not measuring serviceSec. The worker is unavailable for the whole wait, and the ceiling is workers divided by that whole wait.

## 5.3 The deadline is spent in series or in parallel

The caller has a deadline. Call it 400 ms for a checkout page. The handler must authenticate, then ask stock, price, and fraud. Those four have healthy times of 50 ms, 200 ms, 120 ms, and 90 ms.

Done one after another, the page waits for the sum:

    50 + 200 + 120 + 90 = 460 ms

which misses a 400 ms deadline by 60 ms, on a day when every service was healthy. Done as one call and then the other three at once, the page waits for the first call plus the slowest of the rest:

    50 + max(200, 120, 90) = 250 ms

which leaves 150 ms to spare. The two fast calls do not make the page faster. The page is as slow as the slowest call it chose to wait for.

That 250 ms is also the occupancy from the previous section, if the worker blocks until the page is done. serviceSec = 0.25. Eight workers then have

    capacityPerSec = 8 / 0.25 = 32

A latency decision is a capacity decision. Stretch the same stock call from 200 ms to 450 ms and the parallel page becomes 50 + 450 = 500 ms, which is 100 ms over the deadline. Occupancy is now 0.5 s, and the same eight workers can finish only 8 / 0.5 = 16 requests per second. An arrival of 20 per second, which fitted easily under a capacity of 32, is now 4 per second over the ceiling. After 30 s, 120 checkouts are waiting. Nothing about the CPU changed. The workers are simply stuck inside a slow call.

Waiting on several calls also multiplies failure. Suppose stock, price, and fraud each fail on 2% of attempts, and the failures are independent. The page succeeds only when all three succeed:

    0.98 × 0.98 = 0.9604
    0.9604 × 0.98 = 0.941192

So 0.941192 of pages succeed, and 1 − 0.941192 = 0.058808 of them fail: just under 6 in every 100. Out of 100,000 checkouts, that is 5,880.8 failures. A student who says "each dependency is 98% fine, so the page is 98% fine" has treated the page as one of its calls. The page is the combination. Adding a fourth call at the same 2% does not add 2% to the failure. 0.941192 × 0.98 = 0.92236816, so the failure is 1 − 0.92236816 = 0.07763184, which rises from just under 5.9% to just under 7.8%.

The same trap shows up in a short log, without any formula. In 50 checkouts, stock timed out once, price timed out once, and fraud timed out once, each on a different checkout. Each service was fine on 49 of 50 calls, which is 98%. The page failed on 3 of 50, which is 6%. The services did not share their failures, so the page collected all of them.

## 5.4 A cache deletes hits, not misses

A cache answers a repeated read from memory instead of from the database. The quantity that protects the database is not the hit rate by itself. It is the load that remains:

    originPerSec = arrivalPerSec × (1 − hitRate)

Five hundred product reads arrive each second. The database can serve 80 of them. The hit rate has to leave at most 80:

    1 − 80 / 500 = 0.84

At a hit rate of 0.84 the origin sees 500 × 0.16 = 80 per second, which is the database's whole capacity and no headroom. At 0.95 the origin sees 500 × 0.05 = 25 per second, and the database has room. At 0.70 the origin sees 500 × 0.30 = 150 per second, which is 70 above the limit. The database does not slow down by a matching 14% of hit rate. It is asked for almost twice what it can do, and the queue from section 5.2 starts to grow behind it.

Latency has the same shape. A hit takes 2 ms. A miss takes 50 ms. At a hit rate of 0.9 the average is

    0.9 × 2 + 0.1 × 50 = 1.8 + 5 = 6.8 ms

**The misses are a tenth of the calls and 5 of the 6.8 ms.** A student who says "90% of reads hit, so the read takes about as long as the cache" has averaged the counts and forgotten to average the times. The expensive calls dominate the average because they are expensive, not because they are common.

A hit rate is not free freshness. A key kept for a TTL of 30 s can be wrong for 30 s. A price written at the start of that window is still the old price for a buyer who arrives 20 s later. Raising the TTL usually raises the hit rate, and it always raises the longest time a lie can live. "The cache updates when the price changes" is true only if some writer deletes the key. The TTL itself does not watch the database.

When a popular key does expire, everyone misses at once. Two hundred requests for the same product arrive in the same second, all miss, and all go to a database that can do 80 per second. The hit rate over the previous hour is irrelevant to that second. One request should recompute the value. The other 199 should wait for that one. Letting all 200 through is how a cache in front of a database fails open onto it.

## 5.5 A retry is another arrival

A failed request is often sent again. That second send is not a wish. It is another request, and it occupies a worker exactly as the first one did.

The model in this section is a single extra attempt: the client retries once if the first attempt fails, and it does not retry the retry. Failures are independent, and the retry is sent at once, so it lands in the same second's arrival. Under those rules

    attemptsPerSec = arrivalPerSec × (1 + failRate)

Eighty checkouts per second are intended. The service can finish 100 per second. On a healthy minute failRate is 0, attempts equal 80, and there is room. A bad minute fails half of attempts, so failRate = 0.5 and

    attemptsPerSec = 80 × 1.5 = 120

which is 20 over capacity. The queue grows by 20 every second. The original 80 would have fitted. The retries are the part that does not fit.

If the service is failing every attempt, failRate = 1 and attemptsPerSec = 80 × 2 = 160. Successes are still zero. The retries doubled the load and bought no extra success. A student who says "retries only happen when it is already broken, so the extra calls do not matter" is ignoring every neighbour of the broken handler: the pool, the database, and the other callers sharing that capacity of 100.

There is a second, separate damage when the handler did not fail and instead finished late. The client's timeout is 200 ms. The handler commits the charge at 250 ms and only then writes the response. The client has already given up, and it retries at 210 ms. Both requests commit. One click, two ledger rows. **A retry is safe only when a repeated request does the work once.** The usual way to get that is an idempotency key: the client sends the same key on the retry, and the handler, seeing a key it has already committed, returns the first result instead of charging again. Without that key, a timeout that is shorter than the real work turns one payment into two.

The dials fight each other. Retrying less leaves the 40 genuine failures unretried and keeps the load at 80, under the ceiling. Retrying once while half the attempts fail produces 120 and a growing queue, which fails more requests, which creates more retries. During a total outage the retry knob does not raise the number of successes at all. It only chooses how many times capacity is copied onto a service that is returning errors.

## 5.6 The door has a burst and a refill

The front door often limits how fast one caller may send. A token bucket is the usual shape. The bucket holds bucketSize tokens and starts full. Each accepted request spends one token. Tokens come back at refillPerSec, and they stop coming back once the bucket is full. The sustained rate is the refill. The burst is the loan of whatever is already in the bucket.

Starting from a full bucket, a caller who arrives faster than the refill can be allowed at most

    admitted = bucketSize + refillPerSec × windowSec

over a window of windowSec seconds. After the loan is spent, only the refill remains.

Worked example. bucketSize = 40, refillPerSec = 10, the bucket starts full. A person who sends 40 requests at the same instant is allowed all of them. The bucket is then empty, and further requests have to wait for the refill of 10 per second. A scraper that sends 25 per second for 20 s wants 25 × 20 = 500 requests. The door admits

    40 + 10 × 20 = 240

and rejects 500 − 240 = 260. A student who says "a burst of 40 and a refill of 10 means 40 every second" would have expected 800 admissions in those 20 s. The 40 is spent once. It is not a rate.

Raising only the refill, and leaving the bucket at 40, is a different door. refillPerSec = 25 admits 40 + 25 × 20 = 540 over the same window, which is more than 500, so none of the scraper's requests are rejected. Allowing the human's instant burst of 40 needs a bucket of at least 40. Rejecting any of the scraper's 500 requests means the admission ceiling must sit strictly below 500:

    40 + 20 × refillPerSec < 500

which is refillPerSec < 23. A refill of 10 does that. A refill of 25 does not. **The burst is a loan of tokens. The refill is the sustained rate. They are not the same number.**

A rejected request answers 429. Sending it again immediately, with no delay, is the retry from section 5.5 aimed at a door that has just told you it is empty. The tokens have not come back yet. The retry spends nothing useful and adds an arrival.

## 5.7 One sale, all of the limits

The numbers below are a single sale, checked the same way as the sections above. Each limit is doing a different job.

The month's promise is 99.9%, so the budget is 43.2 minutes. Forty minutes are already spent. The remaining budget is 43.2 − 40 = 3.2 minutes. An incident that runs for 10 minutes does not fit.

Checkout is served by 10 workers. On a healthy call the worker blocks for 0.2 s, because the page is authenticate (40 ms) and then the slowest of stock (160 ms), price (90 ms), and fraud (70 ms):

    40 + 160 = 200 ms

The deadline is 300 ms, so this path has 100 ms to spare. Occupancy is 0.2 s, and

    capacityPerSec = 10 / 0.2 = 50

The sale sends 30 checkouts a second. Utilisation is 30 / 50 = 0.6. Headroom is 20 per second. The same four calls placed in series take 40 + 160 + 90 + 70 = 360 ms, which misses the 300 ms deadline by 60 ms even though every service is healthy.

On a slow minute, stock takes 460 ms. The parallel page takes 40 + 460 = 500 ms, over the deadline by 200 ms. Occupancy is 0.5 s. Capacity falls to 10 / 0.5 = 20 per second. Arrival is still 30, so the queue grows by 10 every second. After 20 s, 200 checkouts are waiting. The CPU cost of checkout did not change.

Catalogue reads, separate from checkout, arrive at 300 per second. The cache hit rate is 0.9, so the database sees 300 × 0.1 = 30 per second. It can serve 40, and it is inside its limit. Drop the hit rate to 0.8 and the origin sees 300 × 0.2 = 60, which is 20 over that limit of 40. A price key with a TTL of 30 s, written at the start of the window, is still stale for a buyer at 20 s.

On a later minute stock is healthy again, so occupancy is back to 0.2 s and capacity is back to 50. A bad deploy still holds each worker for that full 0.2 s, then returns an error. Clients retry once and do not retry the retry. failRate = 1, so attempts become 30 × 2 = 60 per second. The queue grows by 10 per second, and the number of successes stays zero.

On a minute when the handler is slow rather than failing, the client's timeout is 200 ms and the handler commits the charge at 250 ms. The client retries at 210 ms. There is no idempotency key. Both requests commit, and one click becomes two charges.

At the door, the bucket holds 20 tokens and refills at 5 per second, starting full. A bot sends 12 per second for 30 s, which is 360 requests. The door admits 20 + 5 × 30 = 170 and rejects 360 − 170 = 190. The real sale, at 30 checkouts a second from many callers, is not that one bot. Limiting the bot does not add workers.

The questions that sort a backend problem are the same shape as the numbers. How many minutes of the promise are left? What is a worker's occupancy, including the waits, and is arrival under workers / occupancy? Does the page wait for a sum or for a max, and how many calls is it allowed to lose? What load remains after the hit rate? Does a retry create a success, or only another arrival? Is the number on the door a loan, or a rate?
