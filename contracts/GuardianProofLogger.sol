// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title GuardianProofLogger
/// @notice Minimal X Layer mainnet helper contract for emitting verifiable
///         Guardian evaluation proofs on-chain.
/// @dev Storage-free design keeps deployment and usage gas low.
contract GuardianProofLogger {
    event EvaluationLogged(
        bytes32 indexed evaluationHash,
        address indexed operator,
        address indexed user,
        address tokenIn,
        address tokenOut,
        uint256 amountRaw,
        uint256 score,
        bool isSafeToExecute,
        string contextSource,
        string metadataURI
    );

    function logEvaluation(
        bytes32 evaluationHash,
        address user,
        address tokenIn,
        address tokenOut,
        uint256 amountRaw,
        uint256 score,
        bool isSafeToExecute,
        string calldata contextSource,
        string calldata metadataURI
    ) external {
        emit EvaluationLogged(
            evaluationHash,
            msg.sender,
            user,
            tokenIn,
            tokenOut,
            amountRaw,
            score,
            isSafeToExecute,
            contextSource,
            metadataURI
        );
    }
}
