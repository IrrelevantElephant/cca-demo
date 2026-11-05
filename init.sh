#!/usr/bin/env bash

if ! command -v scw &>/dev/null; then
  echo "scw could not be found; install the Scaleway CLI to configure deployment secrets."
  exit 1
fi

if ! command -v gh &>/dev/null; then
  echo "gh could not be found; install the GitHub CLI to configure deployment secrets."
  exit 1
fi

scw config get secret-key | gh secret set SCW_SECRET_KEY
scw config get access-key | gh secret set SCW_ACCESS_KEY
scw config get default-organization-id | gh secret set SCW_DEFAULT_ORGANIZATION_ID
scw config get default-project-id | gh secret set SCW_DEFAULT_PROJECT_ID
