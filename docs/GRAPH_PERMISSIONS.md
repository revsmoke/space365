# Decoded Azure AD App Permissions — space365.tpgarchitecture.com

Resource `00000003-0000-0000-c000-000000000000` = **Microsoft Graph** (141 permissions: 3 delegated, 138 application).

Resource `48d79017-a31f-47ce-ba88-03bbc843676f` = **not a publicly documented API**. It is absent from Microsoft's first-party app lists (incl. merill/microsoft-info, 4,394 Microsoft apps), the Graph permissions reference, and all public code/doc search. Its single app role `0beb1fec-a570-47c2-932e-00720b6dd12d` is likewise undocumented. It is most likely a preview/internal Microsoft API or a tenant-specific consented app; verify in Entra portal > Enterprise applications (search by app ID) or via `GET /servicePrincipals(appId='48d79017-a31f-47ce-ba88-03bbc843676f')` (the repo's stored Graph credentials are expired, so this could not be resolved automatically).

## Teams/Chat (72)

| GUID | Name | Type |
|---|---|---|
| f3a65bd4-b703-46df-8f7e-0174fea562aa | Channel.Create | Application |
| 6a118a39-1227-45d4-af0c-ea7b40d210bc | Channel.Delete.All | Application |
| 59a6b24b-4225-4393-8165-ebaec5f55d7a | Channel.ReadBasic.All | Application |
| 3b55498e-47ec-484f-8136-9013221c06a9 | ChannelMember.Read.All | Application |
| 35930dcf-aceb-4bd1-b99a-8ffed403c974 | ChannelMember.ReadWrite.All | Application |
| 7b2449af-6ccd-4f4d-9f78-e550c193f0d1 | ChannelMessage.Read.All | Application |
| 4d02b0cc-d90b-441f-8d82-4fb55c34d6bb | ChannelMessage.UpdatePolicyViolation.All | Application |
| d9c48af6-9ad9-47ad-82c3-63757137b9af | Chat.Create | Application |
| 9c7abde0-eacd-4319-bf9e-35994b1a1717 | Chat.ManageDeletion.All | Application |
| 6b7d71aa-70aa-4810-a8d9-5d9fb2830017 | Chat.Read.All | Application |
| 1c1b4c8e-3cc7-4c58-8470-9b92c9d5848b | Chat.Read.WhereInstalled | Application |
| b2e060da-3baf-4687-9611-f4ebc0f0cbde | Chat.ReadBasic.All | Application |
| 818ba5bd-5b3e-4fe0-bbe6-aa4686669073 | Chat.ReadBasic.WhereInstalled | Application |
| 294ce7c9-31ba-490a-ad7d-97a7d075e4ed | Chat.ReadWrite.All | Application |
| b9bb2381-47a4-46cd-aafb-00cb12f68504 | ChatMessage.Read.All | Application |
| 23fc2474-f741-46ce-8465-674744c5c361 | Team.Create | Application |
| 2280dda6-0bfd-44ee-a2f4-cb867cfc4c1e | Team.ReadBasic.All | Application |
| 660b7406-55f1-41ca-a0ed-0b035e182f3e | TeamMember.Read.All | Application |
| 0121dc95-1b9f-4aed-8bac-58c5ac466691 | TeamMember.ReadWrite.All | Application |
| 4437522e-9a86-4a41-a7da-e380edd4a97d | TeamMember.ReadWriteNonOwnerRole.All | Application |
| 70dec828-f620-4914-aa83-a29117306807 | TeamsActivity.Read.All | Application |
| a267235f-af13-44dc-8385-c1dc93023186 | TeamsActivity.Send | Application |
| 22b74aab-d9e4-46f7-9424-f24b42307227 | TeamsAppInstallation.ManageSelectedForChat.All | Application |
| b448d252-1f26-4227-b6ff-21ab510975a2 | TeamsAppInstallation.ManageSelectedForTeam.All | Application |
| e97a9235-5b3c-43c4-b37d-6786a173fae4 | TeamsAppInstallation.ManageSelectedForUser.All | Application |
| 0fdf35a5-82f8-41ff-9ded-0b761cc73512 | TeamsAppInstallation.Read.All | Application |
| cc7e7635-2586-41d6-adaa-a8d3bcad5ee5 | TeamsAppInstallation.ReadForChat.All | Application |
| 1f615aea-6bf9-4b05-84bd-46388e138537 | TeamsAppInstallation.ReadForTeam.All | Application |
| 9ce09611-f4f7-4abd-a629-a05450422a97 | TeamsAppInstallation.ReadForUser.All | Application |
| 53d40ddb-9b27-4c97-b800-985be6041990 | TeamsAppInstallation.ReadSelectedForChat.All | Application |
| 93c6a289-70fd-489e-a053-6cf8f7d772f6 | TeamsAppInstallation.ReadSelectedForTeam.All | Application |
| 44fb0e7c-1f9a-47f1-bb9e-7f92d48ed288 | TeamsAppInstallation.ReadSelectedForUser.All | Application |
| 6e74eff9-4a21-45d6-bc03-3a20f61f8281 | TeamsAppInstallation.ReadWriteAndConsentForChat.All | Application |
| b0c13be0-8e20-4bc5-8c55-963c23a39ce9 | TeamsAppInstallation.ReadWriteAndConsentForTeam.All | Application |
| 32ca478f-f89e-41d0-aaf8-101deb7da510 | TeamsAppInstallation.ReadWriteAndConsentForUser.All | Application |
| ba1ba90b-2d8f-487e-9f16-80728d85bb5c | TeamsAppInstallation.ReadWriteAndConsentSelfForChat.All | Application |
| 1e4be56c-312e-42b8-a2c9-009600d732c0 | TeamsAppInstallation.ReadWriteAndConsentSelfForTeam.All | Application |
| a87076cf-6abd-4e56-8559-4dbdf41bef96 | TeamsAppInstallation.ReadWriteAndConsentSelfForUser.All | Application |
| 9e19bae1-2623-4c4f-ab6e-2664615ff9a0 | TeamsAppInstallation.ReadWriteForChat.All | Application |
| 5dad17ba-f6cc-4954-a5a2-a0dcc95154f0 | TeamsAppInstallation.ReadWriteForTeam.All | Application |
| 74ef0291-ca83-4d02-8c7e-d2391e6a444f | TeamsAppInstallation.ReadWriteForUser.All | Application |
| 25bbeaad-04be-4207-83ed-a263aae76ddf | TeamsAppInstallation.ReadWriteSelectedForChat.All | Application |
| 7b5823ae-d0f2-424d-b90c-d843ffada7d9 | TeamsAppInstallation.ReadWriteSelectedForTeam.All | Application |
| 650a76ec-4118-4b25-9d3a-1f98048a5ee0 | TeamsAppInstallation.ReadWriteSelectedForUser.All | Application |
| 73a45059-f39c-4baf-9182-4954ac0e55cf | TeamsAppInstallation.ReadWriteSelfForChat.All | Application |
| 9f67436c-5415-4e7f-8ac1-3014a7132630 | TeamsAppInstallation.ReadWriteSelfForTeam.All | Application |
| 908de74d-f8b2-4d6b-a9ed-2a17b3b78179 | TeamsAppInstallation.ReadWriteSelfForUser.All | Application |
| 242607bd-1d2c-432c-82eb-bdb27baa23ab | TeamSettings.Read.All | Application |
| bdd80a03-d9bc-451d-b7c4-ce7c63fe3c8f | TeamSettings.ReadWrite.All | Application |
| 1801e8f4-cf09-4c4e-a1b5-036dfcca6c90 | TeamsPolicyUserAssign.ReadWrite.All | Application |
| b55aa226-33a1-4396-bcf4-edce5e7a31c1 | TeamsResourceAccount.Read.All | Application |
| 49981c42-fd7b-4530-be03-e77b21aed25e | TeamsTab.Create | Application |
| 46890524-499a-4bb2-ad64-1476b4f3e1cf | TeamsTab.Read.All | Application |
| a96d855f-016b-47d7-b51c-1218a98d791c | TeamsTab.ReadWrite.All | Application |
| fd9ce730-a250-40dc-bd44-8dc8d20f39ea | TeamsTab.ReadWriteForChat.All | Application |
| 6163d4f4-fbf8-43da-a7b4-060fe85ed148 | TeamsTab.ReadWriteForTeam.All | Application |
| 425b4b59-d5af-45c8-832f-bb0b7402348a | TeamsTab.ReadWriteForUser.All | Application |
| 9f62e4a2-a2d6-4350-b28b-d244728c4f86 | TeamsTab.ReadWriteSelfForChat.All | Application |
| 91c32b81-0ef0-453f-a5c7-4ce2e562f449 | TeamsTab.ReadWriteSelfForTeam.All | Application |
| 3c42dec6-49e8-4a0a-b469-36cff0d9da93 | TeamsTab.ReadWriteSelfForUser.All | Application |
| a91eadaf-2c3c-4362-908b-fb172d208fc6 | TeamsUserConfiguration.Read.All | Application |
| 6323133e-1f6e-46d4-9372-ac33a0870636 | TeamTemplates.Read.All | Application |
| dfb0dd15-61de-45b2-be36-d6a69fba3c79 | Teamwork.Migrate.All | Application |
| 75bcfbce-a647-4fba-ad51-b63d73b210f4 | Teamwork.Read.All | Application |
| 475ebe88-f071-4bd7-af2b-642952bd4986 | TeamworkAppSettings.Read.All | Application |
| ab5b445e-8f10-45f4-9c79-dd3f8062cc4e | TeamworkAppSettings.ReadWrite.All | Application |
| 0591bafd-7c1c-4c30-a2a5-2b9aacb1dfe8 | TeamworkDevice.Read.All | Application |
| 79c02f5b-bd4f-4713-bc2c-a8a4a66e127b | TeamworkDevice.ReadWrite.All | Application |
| b74fd6c4-4bde-488e-9695-eeb100e4907f | TeamworkTag.Read.All | Application |
| a3371ca5-911d-46d6-901c-42c8c7a937d8 | TeamworkTag.ReadWrite.All | Application |
| fbcd7ef1-df0d-4e05-bb28-93424a89c6df | UserTeamwork.Read.All | Application |
| d4f67ec2-59b5-4bdc-b4af-d78f6f9c1954 | VirtualAppointment.Read.All | Application |

## Mail (0)

_None in this manifest._

## Calendar (7)

| GUID | Name | Type |
|---|---|---|
| 6b22000a-1228-42ec-88db-b8c00399aecb | Bookings.Manage.All | Application |
| 6e98f277-b046-4193-a4f2-6bf6a78cd491 | Bookings.Read.All | Application |
| 0c4b2d20-7919-468d-8668-c54b09d4dee8 | Bookings.ReadWrite.All | Application |
| 9769393e-5a9f-4302-9e3d-7e018ecb64a7 | BookingsAppointment.ReadWrite.All | Application |
| 798ee544-9d2d-430c-a058-570e29e34338 | Calendars.Read | Application |
| 8ba4a692-bc31-4128-9094-475872af8a53 | Calendars.ReadBasic.All | Application |
| ef54d2bf-783f-4e0f-bca1-3210c0444d99 | Calendars.ReadWrite | Application |

## Files/Sites (0)

_None in this manifest._

## Users/Directory (37)

| GUID | Name | Type |
|---|---|---|
| 9c4a07db-e0c1-4fb0-8e85-dfd8ae3b8201 | AgentCard.ReadWrite.ManagedBy | Application |
| 3ee18438-e6e5-4858-8f1c-d7b723b45213 | AgentCardManifest.Read.All | Application |
| 228b1a03-f7ca-4348-b50d-e8a547ab61af | AgentCardManifest.ReadWrite.All | Application |
| 77f6034c-52f5-4526-9fa1-d55a67e72cc4 | AgentCardManifest.ReadWrite.ManagedBy | Application |
| e65ee1da-d1d5-467b-bdd0-3e9bb94e6e0c | AgentCollection.Read.All | Application |
| feb31d7d-a227-4487-898c-e014840d07b3 | AgentCollection.ReadWrite.All | Application |
| 2e0fb698-9996-479f-926b-ce63f4397829 | AgentCollection.ReadWrite.ManagedBy | Application |
| ad25cc1d-84d8-47df-a08e-b34c2e800819 | AgentIdentity.Create.All | Application |
| 4c390976-b2b7-42e0-9187-c6be3bead001 | AgentIdentity.CreateAsManager | Application |
| 5b016f9b-18eb-41d4-869a-66931914d1c8 | AgentIdentity.DeleteRestore.All | Application |
| 69ee0943-4fa4-4ec8-8e52-d12e4ea661a3 | AgentIdentity.EnableDisable.All | Application |
| b2b8f011-2898-4234-9092-5059f6c1ebfa | AgentIdentity.Read.All | Application |
| dcf7150a-88d4-4fe6-9be1-c2744c455397 | AgentIdentity.ReadWrite.All | Application |
| 9a5d68dd-52b0-4cc2-bd40-abcf44ac3a30 | Application.Read.All | Application |
| fc023787-fd04-4e44-9bc7-d454f00c0f0a | Application.ReadUpdate.All | Application |
| 1bfefb4e-e0b5-418b-a88f-73c46d2cc8e9 | Application.ReadWrite.All | Application |
| 18a4783c-866b-4cc7-a460-3d5e5662c884 | Application.ReadWrite.OwnedBy | Application |
| 06b708a9-e830-4db3-a914-8e69da51d44f | AppRoleAssignment.ReadWrite.All | Application |
| 381f742f-e1f8-4309-b4ab-e3d91ae4c5c1 | AuthenticationContext.Read.All | Application |
| a88eef72-fed0-4bf7-a2a9-f19df33f8b83 | AuthenticationContext.ReadWrite.All | Application |
| 64a6cdd6-aab1-4aaf-94b8-3cc8405e90d0 | email | Delegated |
| 14dad69e-099b-42c9-810b-d002981feec1 | profile | Delegated |
| 8556a004-db57-4d7a-8b82-97a13428e96f | User-LifeCycleInfo.Read.All | Application |
| 925f1248-0f97-47b9-8ec8-538c54e01325 | User-LifeCycleInfo.ReadWrite.All | Application |
| 280d0935-0796-47d1-8d26-273470a3f17a | User-Mail.ReadWrite.All | Application |
| a94a502d-0281-4d15-8cd2-682ac9362c4c | User-OnPremisesSyncBehavior.ReadWrite.All | Application |
| 86ceff06-c822-49ff-989a-d912845ffe69 | User-Phone.ReadWrite.All | Application |
| 405a51b5-8d8d-430b-9842-8be4b0e9f324 | User.Export.All | Application |
| 09850681-111b-4a89-9bed-3f2cae46d706 | User.Invite.All | Application |
| e1fe6dd8-ba31-4d61-89e7-88639da4683d | User.Read | Delegated |
| df021288-bdef-4463-88db-98f22de89214 | User.Read.All | Application |
| 97235f07-e226-4f63-ace3-39588e11d3a1 | User.ReadBasic.All | Application |
| 38d9df27-64da-44fd-b7c5-a6fbac20248f | UserAuthenticationMethod.Read.All | Application |
| a1e58be0-1095-422b-b067-73434bd7d40f | UserAuthMethod-Email.Read.All | Application |
| d2c4289f-9f95-40da-ad43-eeb1506f0db7 | UserAuthMethod-External.Read.All | Application |
| a9c5f16e-e5ca-4e33-89ad-903fcfc01c23 | UserAuthMethod-MicrosoftAuthApp.Read.All | Application |
| 8d2c17ff-b93d-40d5-9def-d843680509cb | UserAuthMethod-Password.Read.All | Application |

## Presence (0)

_None in this manifest._

## Planner/Tasks (0)

_None in this manifest._

## CallRecords (11)

| GUID | Name | Type |
|---|---|---|
| f0a35f91-2aa6-4a99-9d5a-5b6bcb66204e | CallEvents-Emergency.Read.All | Application |
| 1abb026f-7572-49f6-9ddd-ad61cbba181e | CallEvents.Read.All | Application |
| a2611786-80b3-417e-adaa-707d4261a5f0 | CallRecord-PstnCalls.Read.All | Application |
| ce8fb1f1-5e1f-44a0-b102-4ec28454d0dc | CallRecordings.Read.All | Application |
| 45bbb07e-7321-4fd7-a8f6-3ff27e6a81c8 | CallRecords.Read.All | Application |
| a7a681dc-756e-4909-b988-f160edc6655f | Calls.AccessMedia.All | Application |
| 284383ee-7f6e-4e40-a2a8-e85dcb029101 | Calls.Initiate.All | Application |
| 4c277553-8a09-487b-8023-29ee378d8324 | Calls.InitiateGroupCall.All | Application |
| f6b49018-60ab-4f81-83bd-22caeabfed2d | Calls.JoinGroupCall.All | Application |
| fd7ccf6b-3d28-418b-9701-cd10f5cd2fd4 | Calls.JoinGroupCallAsGuest.All | Application |
| 4cd61b6d-8692-40bf-9d90-7f38db5e5fce | CallTranscripts.Read.All | Application |

## Other (15)

| GUID | Name | Type |
|---|---|---|
| 8c0aed2c-0c61-433d-b63c-6370ddc73248 | Acronym.Read.All | Application |
| 9f265de7-8d5e-4e9a-a805-5e8bbc49656f | ApprovalSolution.Read.All | Application |
| 45583558-1113-4d06-8969-e79a28edc9ad | ApprovalSolution.ReadWrite.All | Application |
| 99bc85fb-e857-4220-9f8c-3a1c83148d2e | AuditActivity.Read | Application |
| f6318678-2713-4bb6-b123-233e7336c1bd | AuditActivity.Write | Application |
| b0afded3-3588-46d8-8b3d-9842eff778da | AuditLog.Read.All | Application |
| 20e6f8e4-ffac-4cf7-82f7-70ddb7564318 | AuditLogsQuery-CRM.Read.All | Application |
| 0bc85aed-7b0b-437a-bac8-3b29a1b84c99 | AuditLogsQuery-Endpoint.Read.All | Application |
| 7276d950-48fc-4269-8348-f22f2bb296d0 | AuditLogsQuery-Entra.Read.All | Application |
| 6b0d2622-d34e-4470-935b-b96550e5ca8d | AuditLogsQuery-Exchange.Read.All | Application |
| 8a169a81-841c-45fd-ad43-96aede8801a0 | AuditLogsQuery-OneDrive.Read.All | Application |
| 91c64a47-a524-4fce-9bf3-3d569a344ecf | AuditLogsQuery-SharePoint.Read.All | Application |
| 5e1e9171-754d-478c-812c-f1755a9a4c2d | AuditLogsQuery.Read.All | Application |
| be95e614-8ef3-49eb-8464-1c9503433b86 | Bookmark.Read.All | Application |
| 0beb1fec-a570-47c2-932e-00720b6dd12d | UNKNOWN (undocumented API — see note) | Application |

