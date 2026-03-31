# List all users​

<https://clerk.com/docs/reference/backend-api/2025-11-10/tag/users/GET/users>

get/users
curl <https://api.clerk.com/v1/users> \
 --header 'Authorization: Bearer YOUR_SECRET_TOKEN'

```
[
  {
    "id": "string",
    "object": "user",
    "external_id": null,
    "primary_email_address_id": null,
    "primary_phone_number_id": null,
    "primary_web3_wallet_id": null,
    "username": null,
    "first_name": null,
    "last_name": null,
    "locale": null,
    "image_url": "string",
    "has_image": true,
    "public_metadata": {
      "additionalProperty": "anything"
    },
    "private_metadata": null,
    "unsafe_metadata": {
      "additionalProperty": "anything"
    },
    "email_addresses": [
      {
        "id": "string",
        "object": "email_address",
        "email_address": "string",
        "reserved": true,
        "verification": {
          "object": "verification_otp",
          "status": "unverified",
          "strategy": "phone_code",
          "attempts": null,
          "expire_at": null,
          "verified_at_client": null
        },
        "linked_to": [
          {
            "type": "string",
            "id": "string"
          }
        ],
        "matches_sso_connection": true,
        "created_at": 1,
        "updated_at": 1
      }
    ],
    "phone_numbers": [
      {
        "id": "string",
        "object": "phone_number",
        "phone_number": "string",
        "reserved_for_second_factor": true,
        "default_second_factor": true,
        "reserved": true,
        "verification": {
          "object": "verification_otp",
          "status": "unverified",
          "strategy": "phone_code",
          "attempts": null,
          "expire_at": null,
          "verified_at_client": null
        },
        "linked_to": [
          {
            "type": "string",
            "id": "string"
          }
        ],
        "backup_codes": [
          "string"
        ],
        "created_at": 1,
        "updated_at": 1
      }
    ],
    "web3_wallets": [
      {
        "id": "string",
        "object": "web3_wallet",
        "web3_wallet": "string",
        "verification": {
          "object": "verification_web3",
          "status": "unverified",
          "strategy": "web3_metamask_signature",
          "nonce": null,
          "message": null,
          "attempts": null,
          "expire_at": null,
          "verified_at_client": null
        },
        "created_at": 1,
        "updated_at": 1
      }
    ],
    "passkeys": [
      {
        "id": "string",
        "object": "passkey",
        "name": "string",
        "last_used_at": 1,
        "verification": {
          "object": "verification_passkey",
          "status": "verified",
          "strategy": "passkey",
          "nonce": "nonce",
          "message": null,
          "attempts": null,
          "expire_at": null,
          "verified_at_client": null
        }
      }
    ],
    "password_enabled": true,
    "two_factor_enabled": true,
    "totp_enabled": true,
    "backup_code_enabled": true,
    "mfa_enabled_at": null,
    "mfa_disabled_at": null,
    "password_last_updated_at": null,
    "external_accounts": [
      {
        "object": "external_account",
        "id": "string",
        "provider": "string",
        "identification_id": "string",
        "provider_user_id": "string",
        "approved_scopes": "string",
        "email_address": "string",
        "email_address_verified": null,
        "first_name": "string",
        "last_name": "string",
        "image_url": null,
        "username": null,
        "phone_number": null,
        "public_metadata": {
          "additionalProperty": "anything"
        },
        "label": null,
        "created_at": 1,
        "updated_at": 1,
        "verification": {
          "object": "verification_oauth",
          "status": "unverified",
          "strategy": "string",
          "external_verification_redirect_url": "string",
          "error": {
            "message": "string",
            "long_message": "string",
            "code": "string",
            "meta": {}
          },
          "expire_at": 1,
          "attempts": null,
          "verified_at_client": null
        },
        "additionalProperty": "anything"
      }
    ],
    "saml_accounts": [
      {
        "id": "string",
        "object": "saml_account",
        "provider": "string",
        "active": true,
        "email_address": "string",
        "first_name": null,
        "last_name": null,
        "provider_user_id": null,
        "last_authenticated_at": null,
        "public_metadata": {
          "additionalProperty": "anything"
        },
        "verification": {
          "object": "verification_saml",
          "status": "unverified",
          "strategy": "saml",
          "external_verification_redirect_url": null,
          "error": {
            "message": "string",
            "long_message": "string",
            "code": "string",
            "meta": {}
          },
          "expire_at": null,
          "attempts": null,
          "verified_at_client": null
        },
        "saml_connection": {
          "id": "string",
          "name": "string",
          "domains": [
            "string"
          ],
          "active": true,
          "provider": "string",
          "sync_user_attributes": true,
          "allow_subdomains": true,
          "allow_idp_initiated": true,
          "disable_additional_identifications": true,
          "created_at": 1,
          "updated_at": 1
        }
      }
    ],
    "enterprise_accounts": [
      {
        "id": "string",
        "object": "enterprise_account",
        "protocol": "oauth",
        "provider": "string",
        "active": true,
        "email_address": "string",
        "first_name": null,
        "last_name": null,
        "provider_user_id": null,
        "enterprise_connection_id": null,
        "public_metadata": {
          "additionalProperty": "anything"
        },
        "verification": {
          "object": "verification_ticket",
          "status": "unverified",
          "strategy": "ticket",
          "attempts": null,
          "expire_at": null,
          "verified_at_client": null
        },
        "enterprise_connection": {
          "id": "string",
          "protocol": "string",
          "provider": "string",
          "name": "string",
          "logo_public_url": null,
          "domains": [
            "string"
          ],
          "active": true,
          "sync_user_attributes": true,
          "allow_subdomains": true,
          "allow_idp_initiated": true,
          "disable_additional_identifications": true,
          "created_at": 1,
          "updated_at": 1
        },
        "last_authenticated_at": null
      }
    ],
    "organization_memberships": [
      {
        "id": "string",
        "object": "organization_membership",
        "role": "string",
        "role_name": "string",
        "permissions": [
          "string"
        ],
        "public_metadata": {
          "additionalProperty": "anything"
        },
        "private_metadata": {
          "additionalProperty": "anything"
        },
        "organization": {
          "object": "organization",
          "id": "string",
          "name": "string",
          "slug": "string",
          "image_url": "string",
          "has_image": true,
          "members_count": 1,
          "missing_member_with_elevated_permissions": true,
          "pending_invitations_count": 1,
          "max_allowed_memberships": 1,
          "admin_delete_enabled": true,
          "public_metadata": {
            "additionalProperty": "anything"
          },
          "private_metadata": {
            "additionalProperty": "anything"
          },
          "created_by": "string",
          "created_at": 1,
          "updated_at": 1,
          "last_active_at": 1,
          "role_set_key": null
        },
        "public_user_data": {
          "user_id": "string",
          "first_name": null,
          "last_name": null,
          "image_url": "string",
          "has_image": true,
          "identifier": null,
          "username": null
        },
        "created_at": 1,
        "updated_at": 1
      }
    ],
    "last_sign_in_at": null,
    "banned": true,
    "locked": true,
    "lockout_expires_in_seconds": null,
    "verification_attempts_remaining": null,
    "updated_at": 1,
    "created_at": 1,
    "delete_self_enabled": true,
    "create_organization_enabled": true,
    "create_organizations_limit": null,
    "last_active_at": 1700690400000,
    "legal_accepted_at": 1700690400000,
    "bypass_client_trust": false
  }
]
```

Returns a list of all users. The users are returned sorted by creation date, with the newest users appearing first.

Query Parameters
email_addressCopy link to email_address
Type:array string[]
Returns users with the specified email addresses. Accepts up to 100 email addresses. Any email addresses not found are ignored.

phone_numberCopy link to phone_number
Type:array string[]
Returns users with the specified phone numbers. Accepts up to 100 phone numbers. Any phone numbers not found are ignored.

external_idCopy link to external_id
Type:array string[]
Returns users with the specified external IDs. For each external ID, the + and - can be prepended to the ID, which denote whether the respective external ID should be included or excluded from the result set. Accepts up to 100 external IDs. Any external IDs not found are ignored.

usernameCopy link to username
Type:array string[]
Returns users with the specified usernames. Accepts up to 100 usernames. Any usernames not found are ignored.

web3_walletCopy link to web3_wallet
Type:array string[]
Returns users with the specified web3 wallet addresses. Accepts up to 100 web3 wallet addresses. Any web3 wallet addresses not found are ignored.

user_idCopy link to user_id
Type:array string[]
Returns users with the user IDs specified. For each user ID, the + and - can be prepended to the ID, which denote whether the respective user ID should be included or excluded from the result set. Accepts up to 100 user IDs. Any user IDs not found are ignored.

organization_idCopy link to organization_id
Type:array string[]
Returns users that have memberships to the given organizations. For each organization ID, the + and - can be prepended to the ID, which denote whether the respective organization should be included or excluded from the result set. Accepts up to 100 organization IDs.

queryCopy link to query
Type:string
Returns users that match the given query. For possible matches, we check the email addresses, phone numbers, usernames, web3 wallets, user IDs, first and last names. The query value doesn't need to match the exact value you are looking for, it is capable of partial matches as well.

email_address_queryCopy link to email_address_query
Type:string
Returns users with emails that match the given query, via case-insensitive partial match. For example, email_address_query=ello will match a user with the email <HELLO@example.com>.

phone_number_queryCopy link to phone_number_query
Type:string
Returns users with phone numbers that match the given query, via case-insensitive partial match. For example, phone_number_query=555 will match a user with the phone number +1555xxxxxxx.

username_queryCopy link to username_query
Type:string
Returns users with usernames that match the given query, via case-insensitive partial match. For example, username_query=CoolUser will match a user with the username SomeCoolUser.

name_queryCopy link to name_query
Type:string
Returns users with names that match the given query, via case-insensitive partial match.

bannedCopy link to banned
Type:boolean
Returns users which are either banned (banned=true) or not banned (banned=false).

last_active_at_beforeCopy link to last_active_at_before
Type:integer
Example
Returns users whose last session activity was before the given date (with millisecond precision). Example: use 1700690400000 to retrieve users whose last session activity was before 2023-11-23.

last_active_at_afterCopy link to last_active_at_after
Type:integer
Example
Returns users whose last session activity was after the given date (with millisecond precision). Example: use 1700690400000 to retrieve users whose last session activity was after 2023-11-23.

last_active_at_sinceCopy link to last_active_at_since
Type:integer
deprecated
Example
Returns users that had session activity since the given date. Example: use 1700690400000 to retrieve users that had session activity from 2023-11-23 until the current day. Deprecated in favor of last_active_at_after.

created_at_beforeCopy link to created_at_before
Type:integer
Example
Returns users who have been created before the given date (with millisecond precision). Example: use 1730160000000 to retrieve users who have been created before 2024-10-29.

created_at_afterCopy link to created_at_after
Type:integer
Example
Returns users who have been created after the given date (with millisecond precision). Example: use 1730160000000 to retrieve users who have been created after 2024-10-29.

last_sign_in_at_beforeCopy link to last_sign_in_at_before
Type:integer
Example
Returns users whose last sign-in was before the given date (with millisecond precision). Example: use 1700690400000 to retrieve users whose last sign-in was before 2023-11-23.

last_sign_in_at_afterCopy link to last_sign_in_at_after
Type:integer
Example
Returns users whose last sign-in was after the given date (with millisecond precision). Example: use 1700690400000 to retrieve users whose last sign-in was after 2023-11-23.

providerCopy link to provider
Type:string
Returns users with external accounts for the specified OAuth provider. Must be used in combination with the provider_user_id parameter. For example, use provider=oauth_google&provider_user_id=12345 to retrieve a user with Google provider user ID 12345.

provider_user_idCopy link to provider_user_id
Type:array string[]
Returns users with the specified provider user IDs for a specific provider. Must be used in combination with the provider parameter. For example, use provider=oauth_google&provider_user_id=12345 to retrieve a user with Google provider user ID 12345. Accepts up to 100 provider user IDs. Any provider user IDs not found are ignored.

limitCopy link to limit
Type:integer
min:  
1
max:  
500
Default
Applies a limit to the number of results returned. Can be used for paginating the results together with offset.

offsetCopy link to offset
Type:integer
min:  
0
Default
Skip the first offset results when paginating. Needs to be an integer greater or equal to zero. To be used in conjunction with limit.

order_byCopy link to order_by
Type:string
Default
Allows to return users in a particular order. At the moment, you can order the returned users by their created_at,updated_at,email_address,web3wallet,first_name,last_name,phone_number,username,last_active_at,last_sign_in_at. In order to specify the direction, you can use the +/- symbols prepended in the property to order by. For example, if you want users to be returned in descending order according to their created_at property, you can use -created_at. If you don't use + or -, then + is implied. We only support one order_by parameter, and if multiple order_by parameters are provided, we will only keep the first one. For example, if you pass order_by=username&order_by=created_at, we will consider only the first order_by parameter, which is username. The created_at parameter will be ignored in this case.

## Retrieve a user

get/users/{user_id}
Shell Curl
curl '<https://api.clerk.com/v1/users/{user_id}>' \
 --header 'Authorization: Bearer YOUR_SECRET_TOKEN'

Retrieve the details of a user

Path Parameters
user_idCopy link to user_id
Type:string
required
The ID of the user to retrieve

Responses

200
Success
application/json

400
Request was not successful
application/json

401
Authentication invalid
application/json

404
Resource not found
