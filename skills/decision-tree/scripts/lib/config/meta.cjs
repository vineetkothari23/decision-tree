"use strict";

/** Vocabularies the viewer needs: the legacy defaults plus the config schema (roles, field types, locks). */

const constants = require("../constants.cjs");
const { ROLES, REQUIRED_ROLES } = require("./roles.cjs");
const { LEGACY_CONFIG } = require("./legacy.cjs");
const { FIELD_TYPES, BUILTIN_FIELDS, SECTION_NAMES } = require("./sections.cjs");
const { LOCKS } = require("../core/policy/locks.cjs");

const meta = () => ({
  ...constants.meta(),
  roles: ROLES,
  required_roles: REQUIRED_ROLES,
  field_types: FIELD_TYPES,
  builtin_fields: Object.keys(BUILTIN_FIELDS),
  config_sections: SECTION_NAMES,
  locks: LOCKS,
  legacy_config: LEGACY_CONFIG,
});

module.exports = { meta };
