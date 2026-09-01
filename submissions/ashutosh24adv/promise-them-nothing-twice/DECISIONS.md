# Decisions — Promise Them Nothing Twice

## Conflict resolution

I chose the **CTO's contractual hard quota requirement** and explicitly **rejected an invisible Northwind bypass** (e.g. `if (customerId === 'northwind')`).

The conflict between the CTO and Support Lead presents a mathematical and contractual contradiction:
- Northwind's contract is **300 RPM**.
- Northwind's batch traffic sends **800–1200 RPM**.
- The system cannot simultaneously enforce a 300 RPM limit, process 1200 RPM, and return zero 429s.

Implementing a stealth code bypass would corrupt billing metrics, violate enterprise SLA audits, and mask downstream capacity exhaustion. If Northwind must burst to 1200 RPM during 02:00–04:00 UTC, this must be handled as an **auditable commercial agreement** reflected in formal configuration (e.g., an Enterprise Tier limit of 1200 RPM or an explicit scheduled burst allowance), not a midnight exception in middleware. In this vertical slice, `northwind_demo` is configured at 300 RPM and follows the exact same rate-limiting pipeline as every other customer.

---

## Technical design

1. **Algorithm & State Store**:
   - **Per-customer fixed wall-clock UTC minute window** stored in PostgreSQL (`rate_limit_windows` table).
   - Redis was not assumed as guaranteed infrastructure; PostgreSQL is explicitly available in the platform topology.
2. **Distributed Coordination & Multi-Node Safety**:
   - Three stateless application nodes run behind an Nginx round-robin load balancer.
   - Per-process in-memory counters were rejected because requests land randomly across nodes, which would multiply effective limits by up to $3\times$ and fail global enforcement.
3. **Atomic Quota Acquisition**:
   - Quota slot consumption uses an atomic PostgreSQL conditional upsert:
     ```sql
     INSERT INTO rate_limit_windows (customer_id, window_start, request_count)
     VALUES ($1, $2, 1)
     ON CONFLICT (customer_id, window_start)
     DO UPDATE
     SET request_count = rate_limit_windows.request_count + 1
     WHERE rate_limit_windows.request_count < $3
     RETURNING request_count;
     ```
   - PostgreSQL row locks serialize concurrent requests. When quota is exhausted, zero rows match the `WHERE` condition; no rows are updated and the counter is not incremented.
4. **Boundary Tradeoff & Failure Policy**:
   - *Fixed-Window Tradeoff*: Up to $2\times$ quota can be served across a boundary (e.g., end of minute $N$ and start of minute $N+1$). This was accepted for deterministic auditability and simplicity in this vertical slice.
   - *Fail-Closed*: If PostgreSQL is unavailable, requests return `503 Service Unavailable` with `Retry-After: 5` rather than silently allowing unmetered quota breaches.

---

## Verification

The automated load harness (`solution/harness/load-harness.js`) drives high-concurrency requests through the Nginx load balancer (`http://localhost:8080`) and proves:
- **Distributed Quota Enforcement**: 130 concurrent requests hitting a 100 RPM tier across 3 nodes result in **exactly 100x 200 OK** and **exactly 30x 429 Too Many Requests**.
- **Customer Isolation**: Customer A consuming 100 requests does not deplete Customer B's 100 request quota.
- **Header Compliance**: Every 429 response contains a valid `Retry-After` header matching seconds until the next UTC minute.
- **Node Distribution**: Verifies traffic was actively processed across `node1`, `node2`, and `node3`.

*What it does not prove*: Long-term PostgreSQL table bloat over months, multi-region replication latency, or micro-second burst smoothing within sub-second intervals.

---

## If I had four more hours

- **Automated Window Pruning**: Add a periodic background worker (or pg_cron job) executing `DELETE FROM rate_limit_windows WHERE window_start < NOW() - INTERVAL '1 hour'` to prevent table growth.
- **Prometheus / OpenTelemetry Metrics**: Export metrics for `rate_limit_accepted_total`, `rate_limit_rejected_total{customer_id}`, and DB acquisition latency.
- **Dynamic Config Loading**: Store customer tiers and scheduled burst rules in PostgreSQL with cached TTL invalidation instead of static in-code config.
- **Redis + Lua Token Bucket Evaluation**: If Redis is provisioned for production GA, implement a Redis sliding window or token bucket algorithm for sub-minute burst smoothing while retaining PostgreSQL for durable billing audit logs.
- **Chaos / Latency Injection Tests**: Add automated tests simulating database connection spikes and network partition failover.
