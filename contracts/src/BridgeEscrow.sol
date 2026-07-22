// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

/// @title BridgeEscrow — locks USDC for the cross-chain payout leg.
/// In production this is replaced by Circle CCTP burn (Base -> Stellar) ahead
/// of a MoneyGram Ramps SEP-24 withdrawal; here it locks funds and emits the
/// event the payout worker listens for. `release` is the refund path if a
/// payout fails or expires unclaimed.
contract BridgeEscrow {
    IERC20 public immutable token; // USDC
    address public owner;
    mapping(address => bool) public isOrchestrator;
    mapping(bytes32 => uint256) public lockedAmount; // transferId => amount
    mapping(bytes32 => address) public refundTo; // transferId => bound refund target
    mapping(bytes32 => Status) public statusOf;
    uint256 public totalLocked;

    enum Status {
        NONE,
        LOCKED,
        SETTLED,
        RELEASED
    }

    event BridgeOut(bytes32 indexed transferId, uint256 amount, string destChain, string destMemo);
    event Released(bytes32 indexed transferId, uint256 amount, address to);
    event Settled(bytes32 indexed transferId, uint256 amount);

    modifier onlyOrchestrator() {
        require(isOrchestrator[msg.sender], "not orchestrator");
        _;
    }

    constructor(address _token) {
        token = IERC20(_token);
        owner = msg.sender;
    }

    function setOrchestrator(address who, bool enabled) external {
        require(msg.sender == owner, "not owner");
        isOrchestrator[who] = enabled;
    }

    /// Lock USDC for an outbound payout. Emits the event the bridge/payout
    /// worker consumes.
    function lockForPayout(
        bytes32 transferId,
        uint256 amount,
        string calldata destChain,
        string calldata destMemo
    ) external onlyOrchestrator {
        require(statusOf[transferId] == Status.NONE, "already used");
        require(amount > 0, "zero amount");
        require(token.transferFrom(msg.sender, address(this), amount), "pull failed");
        lockedAmount[transferId] = amount;
        refundTo[transferId] = msg.sender;
        statusOf[transferId] = Status.LOCKED;
        totalLocked += amount;
        emit BridgeOut(transferId, amount, destChain, destMemo);
    }

    /// Mark a payout as settled on the far side (cash picked up), then move
    /// the locally locked liquidity back to the protocol treasury.
    function settle(bytes32 transferId) external onlyOrchestrator {
        uint256 amount = lockedAmount[transferId];
        require(statusOf[transferId] == Status.LOCKED, "not locked");
        require(amount > 0, "unknown transfer");
        lockedAmount[transferId] = 0;
        totalLocked -= amount;
        statusOf[transferId] = Status.SETTLED;
        require(token.transfer(owner, amount), "settle transfer failed");
        emit Settled(transferId, amount);
    }

    /// Refund path: payout failed or expired unclaimed.
    function release(bytes32 transferId, address to) external onlyOrchestrator {
        uint256 amount = lockedAmount[transferId];
        require(statusOf[transferId] == Status.LOCKED, "not locked");
        require(amount > 0, "unknown transfer");
        require(to == refundTo[transferId], "wrong refund target");
        lockedAmount[transferId] = 0;
        totalLocked -= amount;
        statusOf[transferId] = Status.RELEASED;
        require(token.transfer(to, amount), "refund failed");
        emit Released(transferId, amount, to);
    }
}
