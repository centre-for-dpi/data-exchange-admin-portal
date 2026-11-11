-- Association rows are revocable grants (user_platform_role) or editable draft choices
-- (api_version_purpose); deleting them is a normal, audited domain operation. Core domain tables
-- stay without DELETE for the runtime role (SPEC.md §5: "nada se borra").
GRANT DELETE ON "user_platform_role", "api_version_purpose" TO rid_app;
