#!/bin/bash
#
# Example External Job Script
#
# This script demonstrates how to use the donkeylabs-job.sh wrapper
# to create an external job that can be executed by the Donkeylabs server.
#

# Get the directory of this script
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Source the job wrapper
source "$SCRIPT_DIR/donkeylabs-job.sh"

# Initialize the job (reads payload from stdin, starts heartbeat)
job_init 5  # 5 second heartbeat interval

# Log that we're starting
job_info "Starting example job"
job_info "Job ID: $DONKEYLABS_JOB_ID"
job_info "Job Name: $DONKEYLABS_JOB_NAME"

# Get configuration from job data
STEPS=$(job_data_get '.steps // 5')
DELAY=$(job_data_get '.delay // 1')

job_info "Processing $STEPS steps with ${DELAY}s delay"

# Process each step
for i in $(seq 1 "$STEPS"); do
    # Calculate progress
    PROGRESS=$(( (i - 1) * 100 / STEPS ))

    # Report progress
    job_progress "$PROGRESS" "Processing step $i of $STEPS"

    # Simulate work
    sleep "$DELAY"

    job_debug "Completed step $i"
done

# Final progress
job_progress 100 "All steps completed"

# Complete the job with result
job_complete "{\"processed\": true, \"steps\": $STEPS}"
