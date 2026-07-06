import type { GraphState } from '../types';
import { dist, polylineLength } from '../geometry/polyline';
import { degree } from './ops';

export interface ValidationIssue {
  kind: 'dangling-ref' | 'endpoint-drift' | 'zero-length' | 'orphan-node';
  subject: string;
  message: string;
}

/** Graph invariants per Plan v2 §2.3 done-when: no dangling refs, no zero-length edges. */
export function validateGraph(g: GraphState): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const e of Object.values(g.edges)) {
    const na = g.nodes[e.a];
    const nb = g.nodes[e.b];
    if (!na || !nb) {
      issues.push({ kind: 'dangling-ref', subject: e.id, message: `${e.id} references a missing node` });
      continue;
    }
    const p = e.points;
    if (dist(p[0], p[1], na.x, na.y) > 0.05 || dist(p[p.length - 2], p[p.length - 1], nb.x, nb.y) > 0.05) {
      issues.push({ kind: 'endpoint-drift', subject: e.id, message: `${e.id} endpoints drifted from its nodes` });
    }
    if (polylineLength(p) < 0.1) {
      issues.push({ kind: 'zero-length', subject: e.id, message: `${e.id} has (near) zero length` });
    }
  }
  for (const n of Object.values(g.nodes)) {
    if (degree(g, n.id) === 0) {
      issues.push({ kind: 'orphan-node', subject: n.id, message: `${n.id} is not connected to any street` });
    }
  }
  return issues;
}
