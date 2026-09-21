import { Router } from 'express';
import { getDb } from '../db/connection.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { buildWardScope, canAccessWard } from '../middleware/access.js';
import { getSlaHours, getSlaStatus } from '../services/sla.js';
import { analyzeSatelliteImagery, generateCaseReviewDossier } from '../services/gemini.js';

const router = Router();
router.use(authenticate);

const VALID_STATUSES = new Set(['NEW', 'UNDER REVIEW', 'NOTICE SENT', 'RESOLVED', 'DISMISSED']);
const VALID_FEEDBACK = new Set(['confirmed', 'false_positive', 'needs_field_inspection']);
const VALID_AI_ACTIONS = new Set(['confirm_violation', 'needs_field_inspection', 'generate_legal_notice', 'mark_false_positive']);

function parseJsonArrayField(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function hydrateAiReview(review) {
  if (!review) return null;

  return {
    ...review,
    legal_basis: parseJsonArrayField(review.legal_basis),
    evidence_gaps: parseJsonArrayField(review.evidence_gaps),
    inspection_checklist: parseJsonArrayField(review.inspection_checklist),
  };
}

function getViolationWithOfficer(db, violationId) {
  return db.prepare(`
    SELECT v.*, u.name as officer_name
    FROM violations v
    LEFT JOIN users u ON v.officer_id = u.id
    WHERE v.id = ?
  `).get(violationId);
}

function buildNoticeContentFromTemplate(templateBody, violation, actorName) {
  const today = new Date().toLocaleDateString('en-IN', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });

  return templateBody
    .replaceAll('{violation_id}', violation.id)
    .replaceAll('{owner_name}', violation.owner_name || 'Unknown')
    .replaceAll('{address}', violation.address)
    .replaceAll('{date}', today)
    .replaceAll('{officer_name}', violation.officer_name || actorName);
}

function applyReviewAction(db, violationId, actionCode, actor) {
  const violation = getViolationWithOfficer(db, violationId);

  if (!violation) {
    throw new Error('Violation not found');
  }

  if (actionCode === 'generate_legal_notice') {
    const template = db.prepare('SELECT * FROM notice_templates WHERE id = ?').get(1);
    if (!template) {
      throw new Error('Notice template not found');
    }

    const content = buildNoticeContentFromTemplate(template.body, violation, actor.name);
    db.prepare(
      'INSERT INTO notices (violation_id, template_id, generated_by, content) VALUES (?, ?, ?, ?)'
    ).run(violationId, template.id, actor.id, content);

    db.prepare("UPDATE violations SET status = 'NOTICE SENT', updated_at = datetime('now') WHERE id = ? AND status != 'RESOLVED'").run(
      violationId
    );

    db.prepare("INSERT INTO activity_logs (message, type, user_id, violation_id) VALUES (?, 'success', ?, ?)").run(
      `AI copilot action generated ${template.name} for ${violationId}`,
      actor.id,
      violationId
    );
  } else {
    const feedbackMap = {
      confirm_violation: 'confirmed',
      needs_field_inspection: 'needs_field_inspection',
      mark_false_positive: 'false_positive',
    };

    const nextStatusMap = {
      confirm_violation: violation.status === 'NEW' ? 'UNDER REVIEW' : violation.status,
      needs_field_inspection: 'UNDER REVIEW',
      mark_false_positive: 'DISMISSED',
    };

    const feedback = feedbackMap[actionCode];
    const nextStatus = nextStatusMap[actionCode] || violation.status;

    if (feedback) {
      db.prepare('INSERT INTO feedback_events (violation_id, user_id, feedback) VALUES (?, ?, ?)').run(
        violationId,
        actor.id,
        feedback
      );
    }

    if (nextStatus !== violation.status) {
      db.prepare("UPDATE violations SET status = ?, updated_at = datetime('now') WHERE id = ?").run(nextStatus, violationId);
    }

    const activityMessages = {
      confirm_violation: `AI copilot action confirmed violation for ${violationId}`,
      needs_field_inspection: `AI copilot action routed ${violationId} for field inspection`,
      mark_false_positive: `AI copilot action marked ${violationId} as false positive`,
    };

    db.prepare("INSERT INTO activity_logs (message, type, user_id, violation_id) VALUES (?, 'info', ?, ?)").run(
      activityMessages[actionCode] || `AI copilot action applied for ${violationId}`,
      actor.id,
      violationId
    );
  }

  return getViolationWithOfficer(db, violationId);
}

function getPermitRegistryMeta(db) {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'integrations'").get();
  if (!row?.value) {
    return {
      source: 'BBMP Permit Database',
      status: 'UNKNOWN',
      lastSync: 'Unavailable',
      records: null,
    };
  }

  try {
    const integrations = JSON.parse(row.value);
    const permitRegistry = integrations.find((entry) => entry.name === 'BBMP Permit Database');
    if (permitRegistry) {
      return {
        source: permitRegistry.name,
        status: permitRegistry.status,
        lastSync: permitRegistry.lastSync,
        records: permitRegistry.records,
      };
    }
  } catch {
    // Fall back to defaults below if settings parsing fails.
  }

  return {
    source: 'BBMP Permit Database',
    status: 'UNKNOWN',
    lastSync: 'Unavailable',
    records: null,
  };
}

function buildPermitCheck(violation, registryMeta) {
  const detectedYear = Number(String(violation.detected_date || '').slice(0, 4)) || null;
  const lastApprovedYear = violation.last_approved_year || null;
  const permitFound = Boolean(lastApprovedYear);

  let mismatchReason = 'Sanction record aligns with the property file. Field inspection should confirm whether the latest built form matches the approved plan.';

  if (!permitFound) {
    mismatchReason = 'No permit record is linked to this survey number in the seeded approval registry.';
  } else if (violation.type === 'No Building Permit') {
    mismatchReason = 'Detected construction activity has no matching commencement or permit renewal record.';
  } else if (violation.type === 'Unauthorized Floor Addition') {
    mismatchReason = 'Detected vertical expansion exceeds the last sanctioned building envelope.';
  } else if (violation.type === 'Setback Violation') {
    mismatchReason = 'Current footprint appears to breach the setback allowed in the approved plan.';
  } else if (violation.type === 'Illegal Basement Construction') {
    mismatchReason = 'Basement-level expansion is not reflected in the last approved structural plan.';
  } else if (violation.type === 'Commercial Use in Residential Zone') {
    mismatchReason = `Permit record is tagged ${violation.zone || 'residential'}, but the current use pattern conflicts with that approval.`;
  } else if (violation.type === 'Encroachment on Public Land') {
    mismatchReason = 'Detected structure footprint extends beyond the approved parcel boundary.';
  } else if (lastApprovedYear && detectedYear && detectedYear - lastApprovedYear > 2) {
    mismatchReason = `The latest approval on file (${lastApprovedYear}) predates the detected construction change.`;
  }

  let matchScore = permitFound ? 72 : 18;

  if (!permitFound) {
    matchScore = 8;
  } else if (violation.type === 'No Building Permit') {
    matchScore = 14;
  } else if (violation.type === 'Unauthorized Floor Addition') {
    matchScore = 34;
  } else if (violation.type === 'Illegal Basement Construction') {
    matchScore = 39;
  } else if (violation.type === 'Setback Violation') {
    matchScore = 43;
  } else if (violation.type === 'Encroachment on Public Land') {
    matchScore = 27;
  } else if (violation.type === 'Commercial Use in Residential Zone') {
    matchScore = 48;
  }

  if (lastApprovedYear && detectedYear && detectedYear - lastApprovedYear > 2) {
    matchScore -= Math.min(20, (detectedYear - lastApprovedYear) * 3);
  }

  matchScore = Math.max(5, Math.min(95, Math.round(matchScore)));

  return {
    permitFound,
    lastApprovedYear,
    mismatchReason,
    matchScore,
    registrySource: registryMeta.source,
    registryStatus: registryMeta.status,
    registryLastSync: registryMeta.lastSync,
    registryRecords: registryMeta.records,
    verifiedBy: 'BBMP Permit Database Sync',
  };
}

// GET /api/violations/crisis-feed - Live critical alert stream for Crisis Dashboard
// Returns: top critical violations + system-wide crisis metrics
router.get('/crisis-feed', (req, res) => {
  const db = getDb();
  try {
    // Critical = NEW or UNDER REVIEW with confidence >= 85, sorted by recency
    const criticalCases = db.prepare(`
      SELECT v.*, u.name as officer_name
      FROM violations v
      LEFT JOIN users u ON v.officer_id = u.id
      WHERE v.status IN ('NEW', 'UNDER REVIEW')
        AND v.confidence >= 85
      ORDER BY v.created_at DESC
      LIMIT 8
    `).all();

    // System metrics
    const totals = db.prepare(`
      SELECT
        SUM(CASE WHEN status = 'NEW' AND confidence >= 90 THEN 1 ELSE 0 END) as critical,
        SUM(CASE WHEN status = 'NEW' THEN 1 ELSE 0 END) as new_cases,
        SUM(CASE WHEN status = 'UNDER REVIEW' THEN 1 ELSE 0 END) as under_review,
        SUM(CASE WHEN officer_id IS NULL AND status IN ('NEW', 'UNDER REVIEW') THEN 1 ELSE 0 END) as unassigned,
        COUNT(*) as total_active
      FROM violations
      WHERE status IN ('NEW', 'UNDER REVIEW')
    `).get();

    // Compute crisis level — CRITICAL if there are unhandled high-confidence new cases
    const criticalCount = totals.critical || 0;
    const unassigned = totals.unassigned || 0;
    let crisisLevel = 'LOW';
    let crisisColor = '#34C759';
    let crisisMessage = 'All systems normal — no immediate crisis';
    if (criticalCount >= 5 || unassigned >= 10) {
      crisisLevel = 'CRITICAL';
      crisisColor = '#FF3B30';
      crisisMessage = `${criticalCount} critical case(s) require immediate dispatch`;
    } else if (criticalCount >= 2 || unassigned >= 5) {
      crisisLevel = 'HIGH';
      crisisColor = '#FF9500';
      crisisMessage = `${criticalCount} high-priority case(s) need urgent action`;
    } else if (totals.new_cases >= 1) {
      crisisLevel = 'ELEVATED';
      crisisColor = '#FFD60A';
      crisisMessage = `${totals.new_cases} new case(s) awaiting review`;
    }

    // Annotate cases with response SLA info (hours since detection)
    const enrichedCases = criticalCases.map((c) => {
      const detectedAt = new Date(c.created_at + 'Z'); // SQLite UTC
      const ageHours = (Date.now() - detectedAt.getTime()) / 3600000;
      const slaHours = getSlaHours(c.confidence);
      const slaStatus = getSlaStatus(ageHours, slaHours);
      return {
        ...c,
        ageHours: Math.round(ageHours * 10) / 10,
        slaHours,
        slaStatus,
      };
    });

    res.json({
      crisisLevel,
      crisisColor,
      crisisMessage,
      metrics: {
        critical: criticalCount,
        newCases: totals.new_cases || 0,
        underReview: totals.under_review || 0,
        unassigned,
        totalActive: totals.total_active || 0,
        slaBreached: enrichedCases.filter((c) => c.slaStatus === 'BREACHED').length,
      },
      criticalCases: enrichedCases,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[crisis-feed] error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/violations - Create a new violation (used by Live Detection scan)
router.post('/', requireRole('inspector', 'commissioner', 'admin'), (req, res) => {
  const db = getDb();
  const {
    address,
    ward,
    ward_no,
    type,
    detected_date,
    confidence,
    lat,
    lng,
    officer_id,
    penalty,
    area,
    height_delta,
    survey_no,
    owner_name,
    zone,
    last_approved_year,
    status,
    source,
  } = req.body || {};

  if (!address || !ward || !type) {
    return res.status(400).json({ error: 'address, ward, and type are required' });
  }

  // Validate officer if provided
  let assignedOfficerId = officer_id || null;
  if (assignedOfficerId) {
    const officer = db.prepare('SELECT id, role FROM users WHERE id = ?').get(assignedOfficerId);
    if (!officer) {
      return res.status(400).json({ error: 'Assigned officer does not exist' });
    }
  }

  const safeStatus = VALID_STATUSES.has(status) ? status : 'NEW';
  const safeDate = detected_date || new Date().toISOString().slice(0, 10);
  const safeConfidence = Math.max(0, Math.min(100, Number(confidence) || 75));

  try {
    // Generate ID and insert atomically — retry on collision (handles race)
    let newId, attempts = 0;
    while (attempts < 5) {
      const allIds = db.prepare(`SELECT id FROM violations WHERE id LIKE '#IW-%'`).all();
      let maxNum = 2846;
      for (const row of allIds) {
        const num = parseInt(String(row.id).replace('#IW-', ''), 10);
        if (!Number.isNaN(num) && num > maxNum) maxNum = num;
      }
      newId = `#IW-${maxNum + 1 + attempts}`;
      const exists = db.prepare('SELECT id FROM violations WHERE id = ?').get(newId);
      if (!exists) break;
      attempts++;
    }
    if (attempts >= 5) {
      return res.status(500).json({ error: 'Could not allocate unique violation ID' });
    }

    db.prepare(`
      INSERT INTO violations (
        id, address, ward, ward_no, type, detected_date, confidence, status,
        officer_id, penalty, area, height_delta, survey_no, owner_name, zone,
        last_approved_year, lat, lng, city
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Bengaluru')
    `).run(
      newId,
      address,
      ward,
      ward_no || null,
      type,
      safeDate,
      safeConfidence,
      safeStatus,
      assignedOfficerId,
      Number(penalty) || 0,
      Number(area) || 0,
      Number(height_delta) || 0,
      survey_no || null,
      owner_name || null,
      zone || null,
      last_approved_year || null,
      Number(lat) || null,
      Number(lng) || null,
    );

    // Activity log
    db.prepare(`
      INSERT INTO activity_logs (message, type, user_id, violation_id)
      VALUES (?, 'success', ?, ?)
    `).run(
      `Violation ${newId} created from ${source || 'manual entry'} — ${type} at ${ward}`,
      req.user.id,
      newId,
    );

    const violation = getViolationWithOfficer(db, newId);
    return res.status(201).json({ violation });
  } catch (err) {
    console.error('[violations] create error:', err);
    return res.status(500).json({ error: err.message || 'Failed to create violation' });
  }
});

// GET /api/violations - List with filters, sorting, pagination
router.get('/', (req, res) => {
  const db = getDb();
  const {
    ward,
    type,
    status,
    confidence_min,
    date_range,
    search,
    sort = 'detected_date',
    order = 'desc',
    page = 1,
    limit = 30,
  } = req.query;

  const where = ['1=1'];
  const params = [];
  const wardScope = buildWardScope(req.user, 'v.ward');

  if (wardScope.clause) {
    where.push(wardScope.clause);
    params.push(...wardScope.params);
  }

  if (ward && ward !== 'All') {
    where.push('v.ward = ?');
    params.push(ward);
  }
  if (type && type !== 'All') {
    where.push('v.type = ?');
    params.push(type);
  }
  if (status && status !== 'All') {
    where.push('v.status = ?');
    params.push(status);
  }
  if (confidence_min) {
    where.push('v.confidence >= ?');
    params.push(Number(confidence_min));
  }
  if (date_range && date_range !== 'All time') {
    const days = { 'Last 7d': 7, 'Last 30d': 30, 'Last 90d': 90 }[date_range];
    if (days) {
      where.push(`v.detected_date >= date('now', '-${days} days')`);
    }
  }
  if (search) {
    where.push('(v.id LIKE ? OR v.address LIKE ? OR v.ward LIKE ?)');
    const s = `%${search}%`;
    params.push(s, s, s);
  }

  const whereClause = where.join(' AND ');
  const validSorts = ['detected_date', 'confidence', 'ward', 'type', 'status', 'address', 'id', 'penalty', 'area'];
  const sortCol = validSorts.includes(sort) ? `v.${sort}` : 'v.detected_date';
  const sortDir = order === 'asc' ? 'ASC' : 'DESC';

  const countRow = db.prepare(`SELECT COUNT(*) as total FROM violations v WHERE ${whereClause}`).get(...params);
  const total = countRow.total;
  const offset = (Number(page) - 1) * Number(limit);

  const rows = db.prepare(`
    SELECT v.*, u.name as officer_name
    FROM violations v
    LEFT JOIN users u ON v.officer_id = u.id
    WHERE ${whereClause}
    ORDER BY ${sortCol} ${sortDir}
    LIMIT ? OFFSET ?
  `).all(...params, Number(limit), offset);

  res.json({
    violations: rows,
    total,
    page: Number(page),
    totalPages: Math.ceil(total / Number(limit)),
  });
});

// GET /api/violations/export - CSV export
router.get('/export', (req, res) => {
  const db = getDb();
  const { ward, type, status, search } = req.query;

  const where = ['1=1'];
  const params = [];
  const wardScope = buildWardScope(req.user, 'v.ward');

  if (wardScope.clause) {
    where.push(wardScope.clause);
    params.push(...wardScope.params);
  }

  if (ward && ward !== 'All') {
    where.push('v.ward = ?');
    params.push(ward);
  }
  if (type && type !== 'All') {
    where.push('v.type = ?');
    params.push(type);
  }
  if (status && status !== 'All') {
    where.push('v.status = ?');
    params.push(status);
  }
  if (search) {
    where.push('(v.id LIKE ? OR v.address LIKE ?)');
    params.push(`%${search}%`, `%${search}%`);
  }

  const rows = db.prepare(`
    SELECT v.id, v.address, v.ward, v.type, v.detected_date, v.confidence, v.status, u.name as officer
    FROM violations v LEFT JOIN users u ON v.officer_id = u.id
    WHERE ${where.join(' AND ')}
    ORDER BY v.detected_date DESC
  `).all(...params);

  const headers = ['id', 'address', 'ward', 'type', 'detected_date', 'confidence', 'status', 'officer'];
  const esc = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
  const csv = [headers.join(','), ...rows.map((row) => headers.map((header) => esc(row[header])).join(','))].join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=infrawatch-violations.csv');
  res.send(csv);
});

// GET /api/violations/:id - Single violation with notes
router.get('/:id', (req, res) => {
  const db = getDb();
  const id = req.params.id;

  const violation = db.prepare(`
    SELECT v.*, u.name as officer_name
    FROM violations v LEFT JOIN users u ON v.officer_id = u.id
    WHERE v.id = ?
  `).get(id);

  if (!violation) {
    return res.status(404).json({ error: 'Violation not found' });
  }
  if (!canAccessWard(req.user, violation.ward)) {
    return res.status(403).json({ error: 'Access denied for this ward' });
  }

  const notes = db.prepare(
    'SELECT * FROM notes WHERE violation_id = ? ORDER BY created_at DESC'
  ).all(id);

  const notices = db.prepare(`
    SELECT
      n.id,
      n.template_id,
      n.content,
      n.created_at,
      n.ai_generated,
      n.ai_provider,
      n.ai_model,
      nt.name as template_name,
      u.name as generated_by_name
    FROM notices n
    LEFT JOIN notice_templates nt ON n.template_id = nt.id
    LEFT JOIN users u ON n.generated_by = u.id
    WHERE n.violation_id = ?
    ORDER BY n.created_at DESC
  `).all(id);

  const activity = db.prepare(`
    SELECT
      l.id,
      l.message,
      l.type,
      l.created_at,
      u.name as user_name
    FROM activity_logs l
    LEFT JOIN users u ON l.user_id = u.id
    WHERE l.violation_id = ?
    ORDER BY l.created_at DESC
    LIMIT 20
  `).all(id);

  const related = db.prepare(`
    SELECT v.id, v.type, v.status, v.penalty, v.address, u.name as officer_name
    FROM violations v LEFT JOIN users u ON v.officer_id = u.id
    WHERE v.ward = ? AND v.id != ? LIMIT 4
  `).all(violation.ward, id);

  const registryMeta = getPermitRegistryMeta(db);
  const permitCheck = buildPermitCheck(violation, registryMeta);
  const feedback = db.prepare(`
    SELECT f.id, f.feedback, f.created_at, u.name as user_name
    FROM feedback_events f
    LEFT JOIN users u ON f.user_id = u.id
    WHERE f.violation_id = ?
    ORDER BY f.created_at DESC, f.id DESC
  `).all(id);

  const aiReviews = db.prepare(`
    SELECT
      r.id,
      r.provider,
      r.model,
      r.confidence,
      r.risk_level,
      r.recommendation_code,
      r.executive_summary,
      r.why_flagged,
      r.legal_basis,
      r.permit_analysis,
      r.action_reason,
      r.evidence_gaps,
      r.inspection_checklist,
      r.notice_strategy,
      r.commissioner_brief,
      r.approval_status,
      r.final_action,
      r.override_notes,
      r.decided_at,
      r.created_at,
      creator.name as created_by_name,
      decider.name as decided_by_name
    FROM ai_case_reviews r
    LEFT JOIN users creator ON creator.id = r.created_by
    LEFT JOIN users decider ON decider.id = r.decided_by
    WHERE r.violation_id = ?
    ORDER BY r.created_at DESC, r.id DESC
    LIMIT 5
  `).all(id).map(hydrateAiReview);

  const imageAnalyses = db.prepare(`
    SELECT
      ia.id,
      ia.provider,
      ia.model,
      ia.before_image_name,
      ia.after_image_name,
      ia.predicted_type,
      ia.confidence,
      ia.change_detected,
      ia.summary,
      ia.rationale,
      ia.recommended_action,
      ia.evidence_points,
      ia.created_at,
      u.name as created_by_name
    FROM image_analyses ia
    LEFT JOIN users u ON ia.created_by = u.id
    WHERE ia.violation_id = ?
    ORDER BY ia.created_at DESC, ia.id DESC
    LIMIT 5
  `).all(id).map((entry) => ({
    ...entry,
    change_detected: Boolean(entry.change_detected),
    evidence_points: entry.evidence_points ? JSON.parse(entry.evidence_points) : [],
  }));

  res.json({
    violation,
    permitCheck,
    feedback,
    notes,
    notices,
    activity,
    related,
    aiReview: aiReviews[0] || null,
    aiReviews,
    imageAnalysis: imageAnalyses[0] || null,
    imageAnalyses,
  });
});

// PATCH /api/violations/:id - Update violation
router.patch('/:id', requireRole('inspector', 'commissioner', 'admin'), (req, res) => {
  const db = getDb();
  const id = req.params.id;
  const { status } = req.body;
  const hasOfficerUpdate = Object.prototype.hasOwnProperty.call(req.body, 'officer_id');
  const hasStatusUpdate = Object.prototype.hasOwnProperty.call(req.body, 'status');

  const existing = db.prepare('SELECT * FROM violations WHERE id = ?').get(id);
  if (!existing) {
    return res.status(404).json({ error: 'Violation not found' });
  }
  if (!canAccessWard(req.user, existing.ward)) {
    return res.status(403).json({ error: 'Access denied for this ward' });
  }

  if (!hasStatusUpdate && !hasOfficerUpdate) {
    const current = db.prepare(`
      SELECT v.*, u.name as officer_name
      FROM violations v
      LEFT JOIN users u ON v.officer_id = u.id
      WHERE v.id = ?
    `).get(id);
    return res.json({ violation: current });
  }

  let normalizedOfficerId = existing.officer_id;
  let selectedOfficer = null;

  if (hasStatusUpdate && !VALID_STATUSES.has(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  if (hasOfficerUpdate) {
    const officerId = req.body.officer_id;

    if (officerId === '' || officerId === null) {
      normalizedOfficerId = null;
    } else {
      selectedOfficer = db.prepare(
        "SELECT id, name, status FROM users WHERE id = ? AND role IN ('field_officer', 'inspector', 'commissioner', 'admin')"
      ).get(Number(officerId));

      if (!selectedOfficer) {
        return res.status(400).json({ error: 'Assigned officer not found' });
      }

      normalizedOfficerId = selectedOfficer.id;
    }
  }

  const statusChanged = hasStatusUpdate && status !== existing.status;
  const officerChanged = hasOfficerUpdate && normalizedOfficerId !== existing.officer_id;

  if (!statusChanged && !officerChanged) {
    const current = db.prepare(`
      SELECT v.*, u.name as officer_name
      FROM violations v
      LEFT JOIN users u ON v.officer_id = u.id
      WHERE v.id = ?
    `).get(id);
    return res.json({ violation: current });
  }

  const updates = [];
  const params = [];

  if (statusChanged) {
    updates.push('status = ?');
    params.push(status);
  }

  if (officerChanged) {
    updates.push('officer_id = ?');
    params.push(normalizedOfficerId);
  }

  updates.push("updated_at = datetime('now')");
  db.prepare(`UPDATE violations SET ${updates.join(', ')} WHERE id = ?`).run(...params, id);

  if (statusChanged) {
    db.prepare("INSERT INTO activity_logs (message, type, user_id, violation_id) VALUES (?, 'info', ?, ?)").run(
      `Status changed to ${status} for ${id}`,
      req.user.id,
      id
    );
  }

  if (officerChanged) {
    const assignmentMessage = normalizedOfficerId
      ? `Assigned ${selectedOfficer?.name || 'officer'} to ${id}`
      : `Cleared officer assignment for ${id}`;

    db.prepare("INSERT INTO activity_logs (message, type, user_id, violation_id) VALUES (?, 'info', ?, ?)").run(
      assignmentMessage,
      req.user.id,
      id
    );
  }

  const updated = db.prepare(`
    SELECT v.*, u.name as officer_name
    FROM violations v
    LEFT JOIN users u ON v.officer_id = u.id
    WHERE v.id = ?
  `).get(id);

  res.json({ violation: updated });
});

// POST /api/violations/:id/notes - Add note
router.post('/:id/notes', requireRole('inspector', 'commissioner', 'admin', 'field_officer'), (req, res) => {
  const db = getDb();
  const { text } = req.body;
  if (!text?.trim()) {
    return res.status(400).json({ error: 'Note text required' });
  }

  const violation = db.prepare('SELECT * FROM violations WHERE id = ?').get(req.params.id);
  if (!violation) {
    return res.status(404).json({ error: 'Violation not found' });
  }
  if (!canAccessWard(req.user, violation.ward)) {
    return res.status(403).json({ error: 'Access denied for this ward' });
  }

  db.prepare('INSERT INTO notes (violation_id, officer_id, officer_name, text) VALUES (?, ?, ?, ?)').run(
    req.params.id,
    req.user.id,
    req.user.name,
    text.trim()
  );

  db.prepare("INSERT INTO activity_logs (message, type, user_id, violation_id) VALUES (?, 'info', ?, ?)").run(
    `Officer ${req.user.name} added note to ${req.params.id}`,
    req.user.id,
    req.params.id
  );

  const notes = db.prepare('SELECT * FROM notes WHERE violation_id = ? ORDER BY created_at DESC').all(req.params.id);
  res.json({ notes });
});

// POST /api/violations/:id/feedback - Human review feedback loop
router.post('/:id/feedback', requireRole('inspector', 'commissioner', 'admin'), (req, res) => {
  const db = getDb();
  const { feedback } = req.body;

  if (!VALID_FEEDBACK.has(feedback)) {
    return res.status(400).json({ error: 'Valid feedback is required' });
  }

  const violation = db.prepare('SELECT * FROM violations WHERE id = ?').get(req.params.id);
  if (!violation) {
    return res.status(404).json({ error: 'Violation not found' });
  }
  if (!canAccessWard(req.user, violation.ward)) {
    return res.status(403).json({ error: 'Access denied for this ward' });
  }

  db.prepare('INSERT INTO feedback_events (violation_id, user_id, feedback) VALUES (?, ?, ?)').run(
    req.params.id,
    req.user.id,
    feedback
  );

  let nextStatus = violation.status;
  let activityType = 'info';
  let feedbackMessage = '';

  if (feedback === 'confirmed') {
    nextStatus = violation.status === 'NEW' ? 'UNDER REVIEW' : violation.status;
    activityType = 'success';
    feedbackMessage = `Reviewer confirmed violation for ${req.params.id}`;
  } else if (feedback === 'false_positive') {
    nextStatus = 'DISMISSED';
    activityType = 'warn';
    feedbackMessage = `Reviewer marked ${req.params.id} as false positive`;
  } else if (feedback === 'needs_field_inspection') {
    nextStatus = 'UNDER REVIEW';
    activityType = 'info';
    feedbackMessage = `Reviewer requested field inspection for ${req.params.id}`;
  }

  if (nextStatus !== violation.status) {
    db.prepare("UPDATE violations SET status = ?, updated_at = datetime('now') WHERE id = ?").run(nextStatus, req.params.id);
  }

  db.prepare(`INSERT INTO activity_logs (message, type, user_id, violation_id) VALUES (?, ?, ?, ?)`).run(
    feedbackMessage,
    activityType,
    req.user.id,
    req.params.id
  );

  const feedbackHistory = db.prepare(`
    SELECT f.id, f.feedback, f.created_at, u.name as user_name
    FROM feedback_events f
    LEFT JOIN users u ON f.user_id = u.id
    WHERE f.violation_id = ?
    ORDER BY f.created_at DESC, f.id DESC
  `).all(req.params.id);

  const updatedViolation = db.prepare(`
    SELECT v.*, u.name as officer_name
    FROM violations v
    LEFT JOIN users u ON v.officer_id = u.id
    WHERE v.id = ?
  `).get(req.params.id);

  res.json({ feedback: feedbackHistory, violation: updatedViolation });
});

// POST /api/violations/:id/ai-review - Generate AI adjudication dossier
router.post('/:id/ai-review', requireRole('inspector', 'commissioner', 'admin'), async (req, res) => {
  const db = getDb();
  const violation = getViolationWithOfficer(db, req.params.id);

  if (!violation) {
    return res.status(404).json({ error: 'Violation not found' });
  }
  if (!canAccessWard(req.user, violation.ward)) {
    return res.status(403).json({ error: 'Access denied for this ward' });
  }

  try {
    const permitCheck = buildPermitCheck(violation, getPermitRegistryMeta(db));
    const recentNotes = db.prepare(`
      SELECT officer_name, text, created_at
      FROM notes
      WHERE violation_id = ?
      ORDER BY created_at DESC
      LIMIT 3
    `).all(req.params.id);
    const latestFeedback = db.prepare(`
      SELECT f.feedback, f.created_at, u.name as user_name
      FROM feedback_events f
      LEFT JOIN users u ON u.id = f.user_id
      WHERE f.violation_id = ?
      ORDER BY f.created_at DESC, f.id DESC
      LIMIT 1
    `).get(req.params.id);
    const latestNotice = db.prepare(`
      SELECT created_at, ai_generated, ai_provider, ai_model, content
      FROM notices
      WHERE violation_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `).get(req.params.id);
    const latestImageAnalysis = db.prepare(`
      SELECT predicted_type, confidence, summary, rationale, recommended_action, created_at
      FROM image_analyses
      WHERE violation_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `).get(req.params.id);

    const dossier = await generateCaseReviewDossier({
      violation,
      permitCheck,
      recentNotes,
      latestFeedback,
      latestNotice,
      latestImageAnalysis,
    });

    const insertResult = db.prepare(`
      INSERT INTO ai_case_reviews (
        violation_id,
        created_by,
        provider,
        model,
        confidence,
        risk_level,
        recommendation_code,
        executive_summary,
        why_flagged,
        legal_basis,
        permit_analysis,
        action_reason,
        evidence_gaps,
        inspection_checklist,
        notice_strategy,
        commissioner_brief,
        raw_response
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      req.params.id,
      req.user.id,
      dossier.provider,
      dossier.model,
      dossier.confidence,
      dossier.riskLevel,
      dossier.recommendationCode,
      dossier.executiveSummary,
      dossier.whyFlagged,
      JSON.stringify(dossier.legalBasis || []),
      dossier.permitAnalysis,
      dossier.actionReason,
      JSON.stringify(dossier.evidenceGaps || []),
      JSON.stringify(dossier.inspectionChecklist || []),
      dossier.noticeStrategy,
      dossier.commissionerBrief,
      dossier.rawResponse
    );

    db.prepare("INSERT INTO activity_logs (message, type, user_id, violation_id) VALUES (?, 'info', ?, ?)").run(
      `AI case review dossier generated for ${req.params.id}`,
      req.user.id,
      req.params.id
    );

    const savedReview = hydrateAiReview(db.prepare(`
      SELECT
        r.id,
        r.provider,
        r.model,
        r.confidence,
        r.risk_level,
        r.recommendation_code,
        r.executive_summary,
        r.why_flagged,
        r.legal_basis,
        r.permit_analysis,
        r.action_reason,
        r.evidence_gaps,
        r.inspection_checklist,
        r.notice_strategy,
        r.commissioner_brief,
        r.approval_status,
        r.final_action,
        r.override_notes,
        r.decided_at,
        r.created_at,
        creator.name as created_by_name,
        decider.name as decided_by_name
      FROM ai_case_reviews r
      LEFT JOIN users creator ON creator.id = r.created_by
      LEFT JOIN users decider ON decider.id = r.decided_by
      WHERE r.id = ?
    `).get(insertResult.lastInsertRowid));

    return res.json({
      review: savedReview,
      violation: getViolationWithOfficer(db, req.params.id),
    });
  } catch (error) {
    console.error('AI case review generation error:', error);
    return res.status(500).json({
      error: error.message || 'Failed to generate AI case review',
      details: error.message,
    });
  }
});

// POST /api/violations/:id/ai-review/:reviewId/decision - Approve or override AI recommendation
router.post('/:id/ai-review/:reviewId/decision', requireRole('inspector', 'commissioner', 'admin'), (req, res) => {
  const db = getDb();
  const { mode = 'approve', action, notes } = req.body;
  const violation = getViolationWithOfficer(db, req.params.id);

  if (!violation) {
    return res.status(404).json({ error: 'Violation not found' });
  }
  if (!canAccessWard(req.user, violation.ward)) {
    return res.status(403).json({ error: 'Access denied for this ward' });
  }

  const review = db.prepare(`
    SELECT *
    FROM ai_case_reviews
    WHERE id = ? AND violation_id = ?
  `).get(Number(req.params.reviewId), req.params.id);

  if (!review) {
    return res.status(404).json({ error: 'AI case review not found' });
  }

  if (!['approve', 'override'].includes(mode)) {
    return res.status(400).json({ error: 'Mode must be approve or override' });
  }

  let finalAction = review.recommendation_code;
  if (mode === 'override') {
    if (!VALID_AI_ACTIONS.has(action)) {
      return res.status(400).json({ error: 'A valid override action is required' });
    }
    finalAction = action;
  }

  const updatedViolation = applyReviewAction(db, req.params.id, finalAction, req.user);

  db.prepare(`
    UPDATE ai_case_reviews
    SET
      approval_status = ?,
      final_action = ?,
      override_notes = ?,
      decided_by = ?,
      decided_at = datetime('now')
    WHERE id = ?
  `).run(
    mode === 'approve' ? 'approved' : 'overridden',
    finalAction,
    notes?.trim() || null,
    req.user.id,
    Number(req.params.reviewId)
  );

  const decisionMessage = mode === 'approve'
    ? `Officer approved AI recommendation ${review.recommendation_code} for ${req.params.id}`
    : `Officer overrode AI recommendation ${review.recommendation_code} -> ${finalAction} for ${req.params.id}`;

  db.prepare("INSERT INTO activity_logs (message, type, user_id, violation_id) VALUES (?, 'success', ?, ?)").run(
    decisionMessage,
    req.user.id,
    req.params.id
  );

  const savedReview = hydrateAiReview(db.prepare(`
    SELECT
      r.id,
      r.provider,
      r.model,
      r.confidence,
      r.risk_level,
      r.recommendation_code,
      r.executive_summary,
      r.why_flagged,
      r.legal_basis,
      r.permit_analysis,
      r.action_reason,
      r.evidence_gaps,
      r.inspection_checklist,
      r.notice_strategy,
      r.commissioner_brief,
      r.approval_status,
      r.final_action,
      r.override_notes,
      r.decided_at,
      r.created_at,
      creator.name as created_by_name,
      decider.name as decided_by_name
    FROM ai_case_reviews r
    LEFT JOIN users creator ON creator.id = r.created_by
    LEFT JOIN users decider ON decider.id = r.decided_by
    WHERE r.id = ?
  `).get(Number(req.params.reviewId)));

  res.json({
    review: savedReview,
    violation: updatedViolation,
  });
});

// POST /api/violations/:id/imagery/analyze - Gemini-assisted image classification
router.post('/:id/imagery/analyze', requireRole('inspector', 'commissioner', 'admin'), async (req, res) => {
  const db = getDb();
  const { beforeImage, afterImage, applyToCase = false } = req.body;

  if (!beforeImage?.dataUrl && !afterImage?.dataUrl) {
    return res.status(400).json({ error: 'Upload at least one imagery file to analyze.' });
  }

  const violation = db.prepare('SELECT * FROM violations WHERE id = ?').get(req.params.id);
  if (!violation) {
    return res.status(404).json({ error: 'Violation not found' });
  }
  if (!canAccessWard(req.user, violation.ward)) {
    return res.status(403).json({ error: 'Access denied for this ward' });
  }

  try {
    const analysis = await analyzeSatelliteImagery({ violation, beforeImage, afterImage });

    const insertResult = db.prepare(`
      INSERT INTO image_analyses (
        violation_id,
        created_by,
        provider,
        model,
        before_image_name,
        after_image_name,
        predicted_type,
        confidence,
        change_detected,
        summary,
        rationale,
        recommended_action,
        evidence_points,
        raw_response
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      req.params.id,
      req.user.id,
      analysis.provider,
      analysis.model,
      beforeImage?.name || null,
      afterImage?.name || null,
      analysis.predictedType,
      analysis.confidence,
      analysis.changeDetected ? 1 : 0,
      analysis.summary,
      analysis.rationale,
      analysis.recommendedAction,
      JSON.stringify(analysis.evidencePoints || []),
      analysis.rawResponse
    );

    let updatedViolation = db.prepare(`
      SELECT v.*, u.name as officer_name
      FROM violations v
      LEFT JOIN users u ON v.officer_id = u.id
      WHERE v.id = ?
    `).get(req.params.id);

    if (applyToCase) {
      db.prepare(`
        UPDATE violations
        SET type = ?, confidence = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(analysis.predictedType, analysis.confidence, req.params.id);

      updatedViolation = db.prepare(`
        SELECT v.*, u.name as officer_name
        FROM violations v
        LEFT JOIN users u ON v.officer_id = u.id
        WHERE v.id = ?
      `).get(req.params.id);
    }

    const logMessage = applyToCase
      ? `AI imagery classification updated ${req.params.id} to ${analysis.predictedType} (${analysis.confidence}%)`
      : `AI imagery classification completed for ${req.params.id}: ${analysis.predictedType} (${analysis.confidence}%)`;

    db.prepare("INSERT INTO activity_logs (message, type, user_id, violation_id) VALUES (?, 'info', ?, ?)").run(
      logMessage,
      req.user.id,
      req.params.id
    );

    const savedAnalysis = db.prepare(`
      SELECT
        ia.id,
        ia.provider,
        ia.model,
        ia.before_image_name,
        ia.after_image_name,
        ia.predicted_type,
        ia.confidence,
        ia.change_detected,
        ia.summary,
        ia.rationale,
        ia.recommended_action,
        ia.evidence_points,
        ia.created_at,
        u.name as created_by_name
      FROM image_analyses ia
      LEFT JOIN users u ON ia.created_by = u.id
      WHERE ia.id = ?
    `).get(insertResult.lastInsertRowid);

    res.json({
      analysis: {
        ...savedAnalysis,
        change_detected: Boolean(savedAnalysis.change_detected),
        evidence_points: savedAnalysis.evidence_points ? JSON.parse(savedAnalysis.evidence_points) : [],
      },
      violation: updatedViolation,
    });
  } catch (error) {
    console.error('Satellite imagery analysis error:', error);
    res.status(500).json({
      error: error.message || 'Failed to analyze imagery',
      details: error.message,
      suggestion: 'Ensure GEMINI_API_KEY is configured and try with a smaller image upload.',
    });
  }
});

// POST /api/violations/bulk-action - Bulk status change
router.post('/bulk-action', requireRole('inspector', 'commissioner', 'admin'), (req, res) => {
  const db = getDb();
  const { action, ids } = req.body;
  if (!action || !ids?.length) {
    return res.status(400).json({ error: 'Action and IDs required' });
  }

  const statusMap = {
    'generate-notice': 'NOTICE SENT',
    'mark-reviewed': 'UNDER REVIEW',
    dismiss: 'DISMISSED',
    resolve: 'RESOLVED',
  };

  const newStatus = statusMap[action];
  if (!newStatus) {
    return res.status(400).json({ error: 'Invalid action' });
  }

  const violations = db.prepare(
    `SELECT id, ward FROM violations WHERE id IN (${ids.map(() => '?').join(', ')})`
  ).all(...ids);
  const blocked = violations.find((violation) => !canAccessWard(req.user, violation.ward));
  if (blocked) {
    return res.status(403).json({ error: 'One or more selected violations are outside your ward access' });
  }

  const update = db.prepare("UPDATE violations SET status = ?, updated_at = datetime('now') WHERE id = ? AND status != 'RESOLVED'");
  for (const violationId of ids) {
    update.run(newStatus, violationId);
  }

  db.prepare("INSERT INTO activity_logs (message, type, user_id) VALUES (?, 'success', ?)").run(
    `Bulk ${action}: ${ids.length} violations`,
    req.user.id
  );

  res.json({ message: `${ids.length} violations updated to ${newStatus}` });
});

export default router;
