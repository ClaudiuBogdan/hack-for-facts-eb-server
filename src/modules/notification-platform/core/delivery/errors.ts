import type {
  DatabaseError,
  NotFoundError,
  QueueError,
  ValidationError,
} from '../shared/errors.js';

export interface DeliveryConflictError {
  type: 'DeliveryConflict';
  deliveryKey: string;
}

export interface InvalidDeliveryTransitionError {
  type: 'InvalidDeliveryTransition';
  from: string;
  to: string;
}

export interface DestinationUnavailableError {
  type: 'DestinationUnavailable';
  userId: string;
  channel: string;
}

export interface DeliveryRenderError {
  type: 'DeliveryRenderError';
  message: string;
}

export interface ProviderDeliveryError {
  type: 'ProviderDeliveryError';
  message: string;
  retryable: boolean;
  code?: string;
}

export type PlatformDeliveryError =
  | DatabaseError
  | ValidationError
  | QueueError
  | NotFoundError
  | DeliveryConflictError
  | InvalidDeliveryTransitionError
  | DestinationUnavailableError
  | DeliveryRenderError
  | ProviderDeliveryError;

export const createDeliveryConflictError = (deliveryKey: string): DeliveryConflictError => ({
  type: 'DeliveryConflict',
  deliveryKey,
});

export const createInvalidDeliveryTransitionError = (
  from: string,
  to: string
): InvalidDeliveryTransitionError => ({
  type: 'InvalidDeliveryTransition',
  from,
  to,
});

export const createDestinationUnavailableError = (
  userId: string,
  channel: string
): DestinationUnavailableError => ({
  type: 'DestinationUnavailable',
  userId,
  channel,
});

export const createDeliveryRenderError = (message: string): DeliveryRenderError => ({
  type: 'DeliveryRenderError',
  message,
});

export const createProviderDeliveryError = (
  message: string,
  retryable: boolean,
  code?: string
): ProviderDeliveryError => ({
  type: 'ProviderDeliveryError',
  message,
  retryable,
  ...(code === undefined ? {} : { code }),
});
