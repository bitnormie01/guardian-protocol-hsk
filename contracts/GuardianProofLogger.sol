// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title GuardianProofLogger
/// @notice Minimal HashKey Chain proof logger for persisting Guardian verdicts.
/// @dev Owner-gated writes keep the evidence feed authoritative.
contract GuardianProofLogger {
    struct EvaluationRecord {
        bool verdict;
        uint256 score;
        uint256 timestamp;
        bool exists;
    }

    address public immutable owner;

    mapping(bytes32 => EvaluationRecord) private evaluations;

    event EvaluationLogged(
        bytes32 indexed evaluationId,
        bool verdict,
        uint256 score,
        uint256 timestamp
    );

    error NotOwner();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    function logEvaluation(
        bytes32 evaluationId,
        bool verdict,
        uint256 score
    ) external onlyOwner {
        uint256 timestamp = block.timestamp;
        evaluations[evaluationId] = EvaluationRecord({
            verdict: verdict,
            score: score,
            timestamp: timestamp,
            exists: true
        });

        emit EvaluationLogged(evaluationId, verdict, score, timestamp);
    }

    function getEvaluation(
        bytes32 evaluationId
    )
        external
        view
        returns (bool verdict, uint256 score, uint256 timestamp, bool exists)
    {
        EvaluationRecord memory record = evaluations[evaluationId];
        return (
            record.verdict,
            record.score,
            record.timestamp,
            record.exists
        );
    }
}
