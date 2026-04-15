import type { CampaignAdminExportLocale } from './csv.js';
import type {
  CampaignAdminEntityNotificationStatus,
  CampaignAdminEntityNotificationType,
} from '@/modules/campaign-admin-entities/index.js';
import type {
  CampaignAdminInstitutionThreadPhase,
  InteractionReviewStatus,
} from '@/modules/learning-progress/index.js';

type SupportedRiskFlag =
  | 'invalid_institution_email'
  | 'institution_email_mismatch'
  | 'missing_official_email'
  | 'institution_thread_failed';

const UNAVAILABLE_LABELS: Readonly<Record<CampaignAdminExportLocale, string>> = {
  en: 'Unavailable',
  ro: 'Indisponibil',
};

const NOT_REVIEWED_LABELS: Readonly<Record<CampaignAdminExportLocale, string>> = {
  en: 'Not reviewed',
  ro: 'Nerevizuit',
};

export function getUnavailableLabel(locale: CampaignAdminExportLocale): string {
  return UNAVAILABLE_LABELS[locale];
}

export function getInteractionTypeLabel(
  locale: CampaignAdminExportLocale,
  interactionId: string
): string {
  switch (interactionId) {
    case 'funky:interaction:public_debate_request':
      return locale === 'ro' ? 'Cerere de dezbatere publica' : 'Public debate request';
    case 'funky:interaction:city_hall_website':
      return locale === 'ro' ? 'Site-ul primariei' : 'City hall website';
    case 'funky:interaction:budget_document':
      return locale === 'ro' ? 'Document buget' : 'Budget document';
    case 'funky:interaction:budget_publication_date':
      return locale === 'ro' ? 'Data publicarii bugetului' : 'Budget publication date';
    case 'funky:interaction:budget_status':
      return locale === 'ro' ? 'Stadiul bugetului' : 'Budget status';
    case 'funky:interaction:city_hall_contact':
      return locale === 'ro' ? 'Contact primarie' : 'City hall contact';
    case 'funky:interaction:funky_participation':
      return locale === 'ro' ? 'Raport de participare' : 'Participation report';
    case 'funky:interaction:budget_contestation':
      return locale === 'ro' ? 'Contestatie bugetara' : 'Budget contestation';
    default:
      return interactionId;
  }
}

export function getReviewStatusLabel(
  locale: CampaignAdminExportLocale,
  status: InteractionReviewStatus | null
): string {
  switch (status) {
    case 'pending':
      return locale === 'ro' ? 'In asteptare' : 'Pending';
    case 'approved':
      return locale === 'ro' ? 'Aprobat' : 'Approved';
    case 'rejected':
      return locale === 'ro' ? 'Respins' : 'Rejected';
    case null:
      return NOT_REVIEWED_LABELS[locale];
  }
}

export function getThreadStatusLabel(
  locale: CampaignAdminExportLocale,
  phase: CampaignAdminInstitutionThreadPhase | null
): string {
  switch (phase) {
    case 'sending':
      return locale === 'ro' ? 'Se trimite' : 'Sending';
    case 'awaiting_reply':
      return locale === 'ro' ? 'Se asteapta raspuns' : 'Awaiting reply';
    case 'reply_received_unreviewed':
      return locale === 'ro' ? 'Raspuns primit' : 'Reply received';
    case 'manual_follow_up_needed':
      return locale === 'ro' ? 'Urmarire manuala' : 'Manual follow-up';
    case 'resolved_positive':
      return locale === 'ro' ? 'Rezolvat pozitiv' : 'Resolved positive';
    case 'resolved_negative':
      return locale === 'ro' ? 'Rezolvat negativ' : 'Resolved negative';
    case 'closed_no_response':
      return locale === 'ro' ? 'Inchis fara raspuns' : 'Closed without reply';
    case 'failed':
      return locale === 'ro' ? 'Conversatie esuata' : 'Thread failed';
    case null:
      return locale === 'ro' ? 'Fara fir' : 'No thread';
  }
}

export function getRiskFlagLabel(
  locale: CampaignAdminExportLocale,
  flag: SupportedRiskFlag
): string {
  switch (flag) {
    case 'invalid_institution_email':
      return locale === 'ro' ? 'Email institutie invalid' : 'Invalid institution email';
    case 'institution_email_mismatch':
      return locale === 'ro' ? 'Neconcordanta email institutie' : 'Institution email mismatch';
    case 'missing_official_email':
      return locale === 'ro' ? 'Lipseste email-ul oficial' : 'Missing official email';
    case 'institution_thread_failed':
      return locale === 'ro' ? 'Esuare conversatie institutie' : 'Institution thread failed';
  }
}

export function getNotificationTypeLabel(
  locale: CampaignAdminExportLocale,
  notificationType: CampaignAdminEntityNotificationType | null
): string {
  switch (notificationType) {
    case 'funky:outbox:welcome':
      return locale === 'ro' ? 'Mesaj de bun venit in campanie' : 'Campaign welcome';
    case 'funky:outbox:entity_subscription':
      return locale === 'ro' ? 'Abonare la entitate' : 'Entity subscription';
    case 'funky:outbox:entity_update':
      return locale === 'ro' ? 'Actualizare entitate' : 'Entity update';
    case null:
      return getUnavailableLabel(locale);
  }
}

export function getNotificationStatusLabel(
  locale: CampaignAdminExportLocale,
  status: CampaignAdminEntityNotificationStatus | null
): string {
  switch (status) {
    case 'pending':
      return locale === 'ro' ? 'In asteptare' : 'Pending';
    case 'composing':
      return locale === 'ro' ? 'In compunere' : 'Composing';
    case 'sending':
      return locale === 'ro' ? 'Se trimite' : 'Sending';
    case 'sent':
      return locale === 'ro' ? 'Trimis' : 'Sent';
    case 'delivered':
      return locale === 'ro' ? 'Livrat' : 'Delivered';
    case 'webhook_timeout':
      return locale === 'ro' ? 'Timeout webhook' : 'Webhook timeout';
    case 'failed_transient':
      return locale === 'ro' ? 'Esec tranzitoriu' : 'Transient failure';
    case 'failed_permanent':
      return locale === 'ro' ? 'Esec permanent' : 'Permanent failure';
    case 'suppressed':
      return locale === 'ro' ? 'Suprimat' : 'Suppressed';
    case 'skipped_unsubscribed':
      return locale === 'ro' ? 'Omis: dezabonat' : 'Skipped: unsubscribed';
    case 'skipped_no_email':
      return locale === 'ro' ? 'Omis: fara email' : 'Skipped: no email';
    case null:
      return getUnavailableLabel(locale);
  }
}
