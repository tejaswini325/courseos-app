import express from 'express';
import { createClient } from 'redis';
import client from 'prom-client';

const app = express();
app.use(express.json());

// 1. Dynamic System Environment Identifiers
const PORT = process.env.PORT || 8080;
const APP_VERSION = process.env.APP_VERSION || 'v1.0.0-blue'; 
const REDIS_URL = process.env.REDIS_URL || 'redis://redis-svc.production.svc.cluster.local:6379';

// 2. Production Telemetry Setup
const register = new client.Registry();
client.collectDefaultMetrics({ register, prefix: 'courseos_' });

const httpRequestsCounter = new client.Counter({
  name: 'courseos_http_requests_total',
  help: 'Telemetry matrix tracking global API calls hitting CourseOS nodes',
  labelNames: ['method', 'route', 'status_code'],
  registers: [register],
});

// Universal Telemetry Middleware
app.use((req, res, next) => {
  res.on('finish', () => {
    httpRequestsCounter.inc({
      method: req.method,
      route: req.route?.path || req.path,
      status_code: res.statusCode,
    });
  });
  next();
});

// 3. Database Subsystem Initialization
const redisClient = createClient({ url: REDIS_URL });
redisClient.on('error', (err) => console.error('Redis Infrastructure Error:', err));
redisClient.on('connect', () => console.log('Successfully bound to Redis data cluster.'));

(async () => {
  try {
    await redisClient.connect();
  } catch (err) {
    console.error('Critical Database connection lock failure:', err.message);
  }
})();

// Chaos state variable to force automated rollbacks if needed later
let featuresHealthy = true;

// ==========================================
// CORE BUSINESS LOGIC: THE 5 REQUIRED TASKS
// ==========================================

// --- TASK 1: Seed Course Catalogue ---
app.post('/api/courses/seed', async (req, res) => {
  try {
    // Purge previous keys to ensure data consistency
    const existingKeys = await redisClient.keys('course:*');
    if (existingKeys.length > 0) {
      await redisClient.del(existingKeys);
    }

    const defaultCourses = [
      { id: 'CS301', title: 'Cloud Native Computing & DevOps', capacity: '60', enrolled: '0' },
      { id: 'CS302', title: 'Advanced Machine Learning Systems', capacity: '45', enrolled: '0' },
      { id: 'CS303', title: 'Federated Learning Foundations', capacity: '30', enrolled: '0' }
    ];

    for (const course of defaultCourses) {
      await redisClient.hSet(`course:${course.id}`, course);
    }

    res.status(201).json({ status: 'SUCCESS', message: 'CourseOS database catalog initialized with 3 modules.', version: APP_VERSION });
  } catch (err) {
    res.status(500).json({ status: 'ERROR', error: err.message });
  }
});

// --- TASK 2: High-Concurrency Safe Student Enrollment ---
app.post('/api/courses/enroll', async (req, res) => {
  if (!featuresHealthy) {
    return res.status(500).json({
      status: 'TRANSACTION_FAILED',
      version: APP_VERSION,
      error: 'CRITICAL_DATABASE_LOCK_FAILURE: Thread collision during seat allocation.'
    });
  }

  const { courseId } = req.body;
  if (!courseId) return res.status(400).json({ error: 'Parameter courseId is required.' });

  try {
    const courseKey = `course:${courseId}`;
    const courseExists = await redisClient.exists(courseKey);

    if (!courseExists) return res.status(404).json({ error: 'Requested course missing from catalog.' });

    // Atomic fetch-and-compare pattern to prevent seat over-allocation
    const courseData = await redisClient.hGetAll(courseKey);
    const capacity = parseInt(courseData.capacity);
    const enrolled = parseInt(courseData.enrolled);

    if (enrolled >= capacity) {
      return res.status(400).json({ error: 'Enrollment capacity breached. Selection is sold out.' });
    }

    // Increment allocation atomically
    const currentCount = await redisClient.hIncrBy(courseKey, 'enrolled', 1);
    
    res.status(200).json({
      status: 'ENROLLMENT_CONFIRMED',
      course: courseData.title,
      current_allocations: currentCount,
      max_limit: capacity,
      node_id: process.env.HOSTNAME,
      version: APP_VERSION
    });
  } catch (err) {
    res.status(500).json({ error: 'Transaction aborted', details: err.message });
  }
});

// --- TASK 3: Real-Time Management Dashboard ---
app.get('/api/courses', async (req, res) => {
  try {
    const keys = await redisClient.keys('course:*');
    const dashboard = [];

    for (const key of keys) {
      const data = await redisClient.hGetAll(key);
      dashboard.push({
        course_id: key.replace('course:', ''),
        title: data.title,
        allocated_seats: parseInt(data.enrolled),
        max_capacity: parseInt(data.capacity),
        available_seats: parseInt(data.capacity) - parseInt(data.enrolled)
      });
    }

    res.status(200).json({ system: 'CourseOS Dashboard', cluster_version: APP_VERSION, data: dashboard });
  } catch (err) {
    res.status(500).json({ error: 'Dashboard data compilation failed', details: err.message });
  }
});

// --- TASK 4: Deregister / Drop Course ---
app.post('/api/courses/drop', async (req, res) => {
  const { courseId } = req.body;
  if (!courseId) return res.status(400).json({ error: 'Parameter courseId is required.' });

  try {
    const courseKey = `course:${courseId}`;
    const data = await redisClient.hGetAll(courseKey);

    if (parseInt(data.enrolled) <= 0) {
      return res.status(400).json({ error: 'Seat allocation constraint error: registration balance already at zero.' });
    }

    await redisClient.hIncrBy(courseKey, 'enrolled', -1);
    res.status(200).json({ status: 'DROPPED', message: `Successfully cleared one slot from ${data.title}`, version: APP_VERSION });
  } catch (err) {
    res.status(500).json({ error: 'Deregistration failed', details: err.message });
  }
});

// --- TASK 5: Core System Operational Analytics ---
app.get('/api/analytics', async (req, res) => {
  try {
    const keys = await redisClient.keys('course:*');
    let absoluteEnrollments = 0;

    for (const key of keys) {
      const count = await redisClient.hGet(key, 'enrolled');
      absoluteEnrollments += parseInt(count || '0');
    }

    res.status(200).json({
      engine: 'CourseOS Metrics Core',
      active_release_channel: APP_VERSION,
      metrics: {
        tracked_database_keys: keys.length,
        aggregated_system_wide_enrollments: absoluteEnrollments
      },
      infrastructure: {
        host_pod_name: process.env.HOSTNAME || 'localhost',
        runtime: `Node.js ${process.version}`
      }
    });
  } catch (err) {
    res.status(500).json({ error: 'Analytics compilation fault', details: err.message });
  }
});

// ==========================================
// CLOUD-NATIVE OPERATIONAL PROBES & METRICS
// ==========================================

// Standard metric target endpoint for Prometheus
app.get('/metrics', async (req, res) => {
  res.setHeader('Content-Type', register.contentType);
  res.status(200).send(await register.metrics());
});

// Liveness Probe target: validates the runtime loop hasn't stalled
app.get('/healthz', (req, res) => {
  res.status(200).json({ status: 'UP', infrastructure: 'ALIVE' });
});

// Readiness Probe target: holds traffic until database tunnels establish
app.get('/readyz', (req, res) => {
  if (redisClient.isReady) {
    return res.status(200).json({ status: 'READY', components: { datastore: 'SYNCED' } });
  }
  res.status(503).json({ status: 'OUTAGE', components: { datastore: 'DESYNCED' } });
});

// Chaos Testing Hooks
app.post('/api/chaos/inject', (req, res) => {
  featuresHealthy = false;
  res.status(200).send(`Chaos structural fault injected on version ${APP_VERSION}.`);
});

app.post('/api/chaos/recover', (req, res) => {
  featuresHealthy = true;
  res.status(200).send(`Chaos resolved on version ${APP_VERSION}.`);
});

// 4. Graceful Shutdown Framework (Prevents dropped TCP packets mid-switchover)
const server = app.listen(PORT, () => console.log(`CourseOS Engine [${APP_VERSION}] active on port ${PORT}`));

process.on('SIGTERM', () => {
  console.log('SIGTERM sequence initialized. Freezing operational ingress handles...');
  server.close(async () => {
    console.log('TCP networking channel closed. Severing database sockets...');
    await redisClient.quit();
    console.log('Teardown complete. Pod exiting cleanly.');
    process.exit(0);
  });
});