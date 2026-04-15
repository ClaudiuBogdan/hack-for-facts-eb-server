/**
 * Email Template Registry
 *
 * Single source of truth for available email templates.
 */

import { registration as adminReviewedUserInteractionRegistration } from './registrations/admin-reviewed-user-interaction.js';
import { registration as alertSeriesRegistration } from './registrations/alert-series.js';
import { registration as anafForexebugDigestRegistration } from './registrations/anaf-forexebug-digest.js';
import { registration as newsletterEntityRegistration } from './registrations/newsletter-entity.js';
import { registration as publicDebateAdminFailureRegistration } from './registrations/public-debate-admin-failure.js';
import { registration as publicDebateCampaignWelcomeRegistration } from './registrations/public-debate-campaign-welcome.js';
import { registration as publicDebateEntitySubscriptionRegistration } from './registrations/public-debate-entity-subscription.js';
import { registration as publicDebateEntityUpdateRegistration } from './registrations/public-debate-entity-update.js';
import { registration as weeklyProgressDigestRegistration } from './registrations/weekly-progress-digest.js';
import { registration as welcomeRegistration } from './registrations/welcome.js';

import type { AnyShellTemplateRegistration } from './types.js';
import type { TemplateRegistry } from '../../core/ports.js';

interface RegistrationEntry {
  label: string;
  registration: unknown;
}

interface IndexedRegistration {
  label: string;
  registration: AnyShellTemplateRegistration;
}

interface IndexedRegistrations {
  registrations: AnyShellTemplateRegistration[];
  registrationMap: Map<string, AnyShellTemplateRegistration>;
}

const isShellTemplateRegistration = (value: unknown): value is AnyShellTemplateRegistration => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const registration = value as Partial<AnyShellTemplateRegistration>;

  return (
    typeof registration.id === 'string' &&
    typeof registration.name === 'string' &&
    typeof registration.version === 'string' &&
    typeof registration.description === 'string' &&
    typeof registration.createElement === 'function' &&
    typeof registration.getSubject === 'function' &&
    Object.hasOwn(registration, 'payloadSchema') &&
    Object.hasOwn(registration, 'exampleProps')
  );
};

export const indexRegistrations = (
  discoveredModules: readonly RegistrationEntry[]
): IndexedRegistrations => {
  const indexed = new Map<string, IndexedRegistration>();

  for (const discoveredModule of discoveredModules) {
    if (!isShellTemplateRegistration(discoveredModule.registration)) {
      throw new Error(
        `Email template registration '${discoveredModule.label}' must export a valid registration object`
      );
    }

    const existing = indexed.get(discoveredModule.registration.id);
    if (existing !== undefined) {
      throw new Error(
        `Duplicate email template id '${discoveredModule.registration.id}' found in '${existing.label}' and '${discoveredModule.label}'`
      );
    }

    indexed.set(discoveredModule.registration.id, {
      label: discoveredModule.label,
      registration: discoveredModule.registration,
    });
  }

  const registrations = [...indexed.values()]
    .map((entry) => entry.registration)
    .sort((left, right) => left.id.localeCompare(right.id));

  return {
    registrations,
    registrationMap: new Map(registrations.map((registration) => [registration.id, registration])),
  };
};

const BUILTIN_REGISTRATIONS: readonly RegistrationEntry[] = [
  {
    label: 'admin-reviewed-user-interaction',
    registration: adminReviewedUserInteractionRegistration,
  },
  {
    label: 'anaf-forexebug-digest',
    registration: anafForexebugDigestRegistration,
  },
  {
    label: 'alert-series',
    registration: alertSeriesRegistration,
  },
  {
    label: 'newsletter-entity',
    registration: newsletterEntityRegistration,
  },
  {
    label: 'public-debate-admin-failure',
    registration: publicDebateAdminFailureRegistration,
  },
  {
    label: 'public-debate-campaign-welcome',
    registration: publicDebateCampaignWelcomeRegistration,
  },
  {
    label: 'public-debate-entity-subscription',
    registration: publicDebateEntitySubscriptionRegistration,
  },
  {
    label: 'public-debate-entity-update',
    registration: publicDebateEntityUpdateRegistration,
  },
  {
    label: 'weekly-progress-digest',
    registration: weeklyProgressDigestRegistration,
  },
  {
    label: 'welcome',
    registration: welcomeRegistration,
  },
];

const { registrations: ALL_REGISTRATIONS, registrationMap } =
  indexRegistrations(BUILTIN_REGISTRATIONS);

// ─────────────────────────────────────────────────────────────────────────────
// Extended Registry (core + shell)
// ─────────────────────────────────────────────────────────────────────────────

export interface ShellTemplateRegistry extends TemplateRegistry {
  /** Get the full shell registration (includes rendering) by template ID */
  getShell(id: string): AnyShellTemplateRegistration | undefined;
  /** Get all shell registrations */
  getAllShell(): AnyShellTemplateRegistration[];
}

/**
 * Creates the template registry.
 */
export const makeTemplateRegistry = (): ShellTemplateRegistry => ({
  get(id) {
    return registrationMap.get(id);
  },
  getAll() {
    return ALL_REGISTRATIONS;
  },
  has(id) {
    return registrationMap.has(id);
  },
  getShell(id) {
    return registrationMap.get(id);
  },
  getAllShell() {
    return ALL_REGISTRATIONS;
  },
});

export type { ShellTemplateRegistration } from './types.js';
