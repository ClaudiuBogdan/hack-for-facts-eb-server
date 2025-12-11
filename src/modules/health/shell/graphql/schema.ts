/**
 * GraphQL Schema Definition (SDL)
 */
export const schema = `
  extend type Query {
    """
    Service liveness check
    """
    health: String!

    """
    Service readiness check with detailed component status
    """
    ready: Readiness!
  }

  type Readiness {
    status: String!
    version: String
    uptime: Float!
    checks: [HealthCheck!]!
    timestamp: String!
  }

  type HealthCheck {
    name: String!
    status: String!
    message: String
    latencyMs: Float
  }
`;
