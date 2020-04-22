#!/bin/bash
set -euo pipefail
scriptdir="$(cd $(dirname $0) && pwd)"
version="${1:-}"
if [ -z "${version}" ]; then
  echo "Usage: $0 vVERSION"
  echo "Example: $0 1.0.0"
  exit 1
fi

bundle="aws-cdk-${version}.zip"
mkdir -p bundles
out="bundles/${bundle}"

if [ ! -f ${out} ]; then
  echo "Downloading CDK bundle for v${version}..."
  curl -#fL "https://github.com/awslabs/aws-cdk/releases/download/v${version}/${bundle}" -o ${out}
else
  echo "Found ${out}. Skipping download."
fi

echo "Extracting all .jsii files from ${out}..."
${scriptdir}/extract-jsii.sh ${out}

echo "Creating CSV report..."
npm install
npx ts-node ${scriptdir}/create-report.ts

