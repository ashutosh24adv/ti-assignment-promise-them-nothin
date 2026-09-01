# RelayAPI Distributed Rate Limiter — Solution

A distributed, auditable, PostgreSQL-backed rate limiter for RelayAPI designed to enforce hard per-customer quotas across multiple stateless application nodes.

---

## 1. Architecture

```text
                  Client / Load Test Harness
                             │
                             ▼
             ┌───────────────────────────────┐
             │    Nginx Load Balancer        │
             │   (http://localhost:8080)     │
             └───────────────┬───────────────┘
                             │ (Round-Robin)
          ┌──────────────────┼──────────────────┐
          ▼                  ▼                  ▼
  ┌───────────────┐  ┌───────────────┐  ┌───────────────┐
  │  Node 1 (App) │  │  Node 2 (App) │  │  Node 3 (App) │
  │ (Port 3001)   │  │ (Port 3002)   │  │ (Port 3003)   │
  └───────┬───────┘  └───────┬───────┘  └───────┬───────┘
          │                  │                  │
          └──────────────────┼──────────────────┘
                             ▼
             ┌───────────────────────────────┐
             │       PostgreSQL 16           │
             │    Shared Distributed State   │
             │      (rate_limit_windows)     │
             └───────────────────────────────┘
```

### Key Architectural Properties
* **Stateless App Nodes**: Three identical Express application instances running without shared memory or sticky sessions.
* **Shared Distributed State**: Coordination is handled via PostgreSQL row-level locks, guaranteeing strict consistency across all application nodes.
* **Zero In-Memory Drift**: Rejects per-process counters (`const counters = {}`) that would multiply effective limits by $3\times$ behind a load balancer.

---

## 2. Rate Limiting Algorithm & Concurrency Model

### Algorithm: Per-Customer Fixed UTC Minute Window
* Every incoming request must provide a valid `X-Customer-Id` header matching a registered customer tier.
* Missing or unknown customer IDs are rejected immediately with `400 Bad Request` to preserve auditability and prevent state exhaustion.
* Valid requests are mapped to a UTC wall-clock minute window `(customer_id, window_start)`.

### Atomic Database Operation
Quota consumption uses an atomic PostgreSQL conditional upsert:

```sql
INSERT INTO rate_limit_windows (customer_id, window_start, request_count)
VALUES ($1, $2, 1)
ON CONFLICT (customer_id, window_start)
DO UPDATE
SET request_count = rate_limit_windows.request_count + 1
WHERE rate_limit_windows.request_count < $3
RETURNING request_count;
```

### Why This is Concurrency-Safe
1. **Row-Level Serialization**: PostgreSQL takes an exclusive row lock on `(customer_id, window_start)` during the `ON CONFLICT DO UPDATE`.
2. **Atomic Quota Check**: The `WHERE rate_limit_windows.request_count < $3` clause checks and increments within the same atomic transaction.
3. **No Phantom Increments**: When the limit is reached, zero rows match the `WHERE` clause. No rows are updated, `RETURNING request_count` yields empty rows, and the counter is **not** incremented.
4. **Result**:
   * If `rows.length === 1` $\implies$ Slot acquired $\implies$ HTTP `200 OK`.
   * If `rows.length === 0` $\implies$ Quota exhausted $\implies$ HTTP `429 Too Many Requests` with `Retry-After`.

---

## 3. Quickstart & Running the Service (≤ 15 Minutes)

You can run the system using either **Docker Compose** (standard containerized deployment) or the **Native Cluster Runner** (zero-docker local runtime).

### Option A: Running via Docker Compose

```bash
# 1. Navigate to the solution directory
cd submissions/ashutosh24adv/promise-them-nothing-twice/solution

# 2. Build and start PostgreSQL, 3 app nodes, and Nginx load balancer
docker compose up --build -d

# 3. Install dependencies and run the test suites
npm install
npm run harness             # Standard multi-scenario verification
npm run test:adversarial    # Edge-case & high-concurrency stress tests
```

To stop containers:
```bash
docker compose down -v
```

---

### Option B: Running Locally without Docker

If Docker is not running on your host, use the native 3-node cluster orchestrator backed by local PostgreSQL:

```bash
# 1. Navigate to solution directory and install dependencies
cd submissions/ashutosh24adv/promise-them-nothing-twice/solution
npm install

# 2. Start the 3-node cluster and reverse proxy load balancer
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/relayapi npm run start:cluster

# 3. In another terminal, run the test suites
npm run harness
npm run test:adversarial
```

---

## 4. Expected Harness Output

```text
===========================================================================
       RELAYAPI DISTRIBUTED RATE LIMITER LOAD HARNESS                      
===========================================================================

[Harness] Verifying connection to Load Balancer at http://localhost:8080...
[Harness] Load Balancer healthy (served by node1).

[Harness] Current UTC minute has 54.8s remaining. Safe to execute test bursts.

[Scenario A] Sending 100 concurrent requests for customer_a (Limit: 100)...
[Scenario B] Sending 100 concurrent requests for customer_b (Limit: 100)...
[Scenario C] Sending 130 concurrent requests for customer_c (Limit: 100, Burst: 130)...

============================= HARNESS RESULTS =============================
Scenario / Customer    | Sent     | 200 OK     | 429 Limit    | 5xx / Err    | Status    
-----------------------+----------+------------+--------------+--------------+-----------
customer_a (100 RPM)   | 100      | 100        | 0            | 0            | PASS      
customer_b (100 RPM)   | 100      | 100        | 0            | 0            | PASS      
customer_c (100 RPM)   | 130      | 100        | 30           | 0            | PASS      
===========================================================================

Multi-Node Distribution Breakdown:
┌─────────┬────────┐
│ (index) │ Values │
├─────────┼────────┤
│ node2   │ 100    │
│ node3   │ 100    │
│ node1   │ 100    │
└─────────┴────────┘
Total active nodes handling traffic: 3
Sample 429 Response Header: Retry-After = 55s
Sample 429 Response Body: {"error":"rate limit exceeded","customerId":"customer_c","limit":100,"retryAfter":55}

>>> ALL HARNESS ASSERTIONS PASSED SUCCESSFULLY (Exit Code 0) <<<
```

---

## 5. Counting Semantics & Boundary Behavior

* **Definition of Window**: Each window spans exactly from `YYYY-MM-DD HH:MM:00.000Z` to `YYYY-MM-DD HH:MM:59.999Z`.
* **Counting Rule**: At most `LIMIT` requests are admitted per customer in each discrete UTC minute window.
* **Fixed-Window Boundary Burst Tradeoff**:
  * If Customer A sends 100 requests at `12:00:59.500` and another 100 requests at `12:01:00.500`, both bursts will be admitted because they fall into separate UTC minute windows.
  * Over that 2-second interval, 200 requests were processed.
  * **Why Fixed-Window for this slice**: It is simple, deterministic, auditable for customer compliance, and provides absolute coordination via PostgreSQL without requiring Redis or complex distributed consensus. In production, a Redis Lua Token Bucket or GCRA could be layered to smooth window-edge bursts.

---

## 6. Failure Mode & Error Handling (Fail-Closed)

* **Policy**: When the rate limiter state store (PostgreSQL) cannot be contacted or encounters a critical error, the system **fails closed**.
* **Response**: Returns `503 Service Unavailable` with `Retry-After: 5`.
* **Rationale**: Failing open would allow unbounded traffic to overwhelm downstream services and violate contractual billing quotas. Returning 503 makes the infrastructure outage transparent rather than misleading the client with a 429 (which implies a customer quota breach).

---

## 7. Resolution of the Northwind Conflict

* **The Problem**:
  * CTO: "A customer must never exceed contracted quota (300 RPM)."
  * Support Lead: "Northwind (800–1200 RPM batch) must never see a 429."
* **The Resolution**:
  * **No invisible application bypass**: We explicitly reject implementing `if (customerId === 'northwind')` in middleware.
  * Hardcoded bypasses create severe operational risk, defeat audit compliance, and hide true platform capacity requirements.
  * Northwind's traffic is metered through the exact same rate-limiting engine as all other customers.
  * If Northwind requires 1200 RPM for nightly operations, that must be configured as an explicit **commercial tier change** or formal scheduled burst policy in configuration, not a stealth backdoor in production code.

---

## 8. What the Harness Proves vs. Does Not Prove

### What the Harness Proves:
1. **Multi-Node Coordination**: Requests routed across 3 stateless nodes respect a single shared global quota.
2. **Customer Isolation**: Customer A's traffic does not decrement Customer B's budget.
3. **Hard Boundary Accuracy**: When 130 concurrent requests hit a 100 RPM quota, exactly 100 succeed (200 OK) and exactly 30 are rejected (429 Too Many Requests).
4. **Header Compliance**: Every 429 response contains a valid `Retry-After` header indicating seconds until the next window.
5. **No Counter Leakage**: Rejected requests do not increment the database counter.

### What the Harness Does Not Prove:
1. **High-Scale DB Saturation**: Single-instance PostgreSQL scaling beyond thousands of queries per second.
2. **Multi-Region Latency**: Quota synchronization across geographically dispersed data centers.
3. **Sub-Minute Burst Smoothing**: Smoothing bursts within a single second window (inherent tradeoff of fixed-window vs. token bucket).
4. **NTP Clock Drift**: Behavior if application node clocks diverge by more than a few hundred milliseconds.
