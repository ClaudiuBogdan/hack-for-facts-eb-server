/**
 * Shell-layer template registration types.
 *
 * Extends core TemplateRegistration with rendering capabilities.
 */

import type { TemplateRegistration } from '../../core/ports.js';
import type { BaseTemplateProps, EmailTemplateProps, EmailTemplateType } from '../../core/types.js';
import type { TSchema, Static } from '@sinclair/typebox';
// eslint-disable-next-line @typescript-eslint/naming-convention -- React is a third-party naming standard
import type * as React from 'react';

type TemplateProps<TType extends EmailTemplateType, TPayload extends TSchema> = BaseTemplateProps &
  Static<TPayload> & { templateType: TType };

/**
 * Full template registration including rendering capabilities.
 * Shell-layer extension of the core TemplateRegistration.
 */
export interface ShellTemplateRegistration<
  TType extends EmailTemplateType = EmailTemplateType,
  TPayload extends TSchema = TSchema,
  TProps extends TemplateProps<TType, TPayload> = TemplateProps<TType, TPayload>,
> extends TemplateRegistration<TType, TPayload> {
  /** Creates the React element for this template */
  createElement(props: TProps): React.ReactElement;
  /** Generates the email subject line */
  getSubject(props: TProps): string;
  /**
   * Example props for rendering a realistic preview of this template.
   *
   * Used by:
   * - `EmailRenderer.getTemplate(type).exampleProps` — retrieve example props,
   *   then pass them to `renderer.render(exampleProps)` to produce a preview HTML.
   * - Tests — verify that every registered template can render without errors.
   *
   * Must contain valid, realistic sample data (not empty/placeholder values)
   * that passes the template's `payloadSchema` validation.
   */
  exampleProps: TProps;
}

/**
 * Helper that preserves the relationship between id, props, and payload schema.
 */
export const defineTemplate = <
  TType extends EmailTemplateType,
  TPayload extends TSchema,
  TProps extends TemplateProps<TType, TPayload>,
>(
  registration: ShellTemplateRegistration<TType, TPayload, TProps>
): ShellTemplateRegistration<TType, TPayload, TProps> => registration;

export type AnyShellTemplateRegistration = ShellTemplateRegistration<
  EmailTemplateType,
  TSchema,
  EmailTemplateProps
>;
