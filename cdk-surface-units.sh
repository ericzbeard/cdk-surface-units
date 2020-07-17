#!/bin/bash
set -euo pipefail
scriptdir="$(cd $(dirname $0) && pwd)"
version="${1:-}"
persist="${2:-}"
if [ -z "${version}" ]; then
  echo "Usage: $0 VERSION csvonly|mysql|rest"
  echo "Example: $0 1.0.0 csvonly"
  exit 1
fi

if [ -z "${persist}" ]; then
  persist=csvonly
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
#npm install
#npx ts-node ${scriptdir}/create-report.ts $persist
node ${scriptdir}/create-report.js $persist $version
