-- Explainable project-verification planner output; nullable for every legacy request.
ALTER TABLE execution_requests ADD COLUMN verification_plan TEXT;
