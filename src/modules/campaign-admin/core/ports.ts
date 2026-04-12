export interface CampaignAdminPermissionAuthorizer {
  hasPermission(input: { userId: string; permissionName: string }): Promise<boolean>;
}
