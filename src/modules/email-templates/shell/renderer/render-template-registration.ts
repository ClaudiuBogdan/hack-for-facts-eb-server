import { render } from '@react-email/render';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { err, ok, type Result } from 'neverthrow';

import { BaseTemplatePropsSchema } from '../../core/schemas.js';

import type { TemplateError } from '../../core/ports.js';
import type { RenderedEmail } from '../../core/types.js';
import type { AnyShellTemplateRegistration } from '../registry/types.js';

interface RenderableTemplateProps {
  templateType: string;
}

const getValidationErrorMessage = (
  registration: AnyShellTemplateRegistration,
  props: RenderableTemplateProps
): string => {
  const fullSchema = Type.Intersect([
    BaseTemplatePropsSchema,
    registration.payloadSchema,
    Type.Object({ templateType: Type.Literal(registration.id) }),
  ]);

  const errors = [...Value.Errors(fullSchema, props)]
    .map((error) => `${error.path}: ${error.message}`)
    .join(', ');

  return `Payload validation failed: ${errors}`;
};

export const renderTemplateRegistration = async (
  registration: AnyShellTemplateRegistration,
  props: RenderableTemplateProps
): Promise<Result<RenderedEmail, TemplateError>> => {
  const fullSchema = Type.Intersect([
    BaseTemplatePropsSchema,
    registration.payloadSchema,
    Type.Object({ templateType: Type.Literal(registration.id) }),
  ]);

  if (!Value.Check(fullSchema, props)) {
    return err({
      type: 'VALIDATION_ERROR',
      message: getValidationErrorMessage(registration, props),
      templateType: props.templateType,
    });
  }

  try {
    const element = registration.createElement(props as never);
    const subject = registration.getSubject(props as never);
    const html = await render(element, { pretty: true });
    const text = await render(element, { plainText: true });

    return ok({
      subject,
      html,
      text,
      templateName: registration.id,
      templateVersion: registration.version,
    });
  } catch (error) {
    return err({
      type: 'RENDER_ERROR',
      message: error instanceof Error ? error.message : 'Unknown render error',
      templateType: props.templateType,
    });
  }
};
