/**
 * Environment File Protection Plugin
 *
 * Prevents OpenCode from reading .env files which contain secrets
 * (API keys, database credentials, etc.)
 *
 * @see https://opencode.ai/docs/plugins/#env-protection
 */
export const EnvProtection = async () => {
  return {
    'tool.execute.before': async (input, output) => {
      // Block read tool from accessing .env files
      if (input.tool === 'read' && output.args.filePath.includes('.env')) {
        throw new Error(
          'Access denied: .env files contain secrets and cannot be read. Use .env.example as a template reference instead.'
        );
      }

      // Block bash commands that try to read .env files
      if (input.tool === 'bash') {
        const command = output.args.command || '';
        const envPatterns = [
          /\bcat\b.*\.env/i,
          /\bhead\b.*\.env/i,
          /\btail\b.*\.env/i,
          /\bless\b.*\.env/i,
          /\bmore\b.*\.env/i,
          /\bvi\b.*\.env/i,
          /\bvim\b.*\.env/i,
          /\bnano\b.*\.env/i,
        ];

        if (envPatterns.some((pattern) => pattern.test(command))) {
          throw new Error(
            'Access denied: .env files contain secrets and cannot be read via bash. Use .env.example as a template reference instead.'
          );
        }
      }
    },
  };
};
