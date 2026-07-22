// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @title RemitVault — per-user custody of one currency token (EURe for the
/// launch corridor). Deposits are credited by the ramp role (the Monerium
/// adapter, after a SEPA transfer mints EURe to this vault). Debits are made
/// by the orchestrator role when a user sends a remittance, subject to a
/// per-user daily cap and a global pause.
contract RemitVault {
    IERC20 public immutable token;
    address public owner;
    bool public paused;

    /// Max a single user may send per UTC day (in token units).
    uint256 public dailyCap;

    mapping(address => bool) public isRamp;
    mapping(address => bool) public isOrchestrator;
    mapping(address => uint256) public balanceOf;
    /// user => day index => amount debited that day
    mapping(address => mapping(uint256 => uint256)) public debitedOnDay;
    /// transferId => already processed (idempotency at the contract layer)
    mapping(bytes32 => bool) public processedTransfer;
    /// deposit ref => already processed (idempotency at the contract layer)
    mapping(bytes32 => bool) public processedDeposit;

    event Deposited(address indexed user, uint256 amount, bytes32 indexed ref);
    event Debited(address indexed user, uint256 amount, address indexed to, bytes32 indexed transferId);
    event Paused(bool paused);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    modifier notPaused() {
        require(!paused, "paused");
        _;
    }

    constructor(address _token, uint256 _dailyCap) {
        token = IERC20(_token);
        owner = msg.sender;
        dailyCap = _dailyCap;
    }

    function setRamp(address who, bool enabled) external onlyOwner {
        isRamp[who] = enabled;
    }

    function setOrchestrator(address who, bool enabled) external onlyOwner {
        isOrchestrator[who] = enabled;
    }

    function setPaused(bool _paused) external onlyOwner {
        paused = _paused;
        emit Paused(_paused);
    }

    function setDailyCap(uint256 cap) external onlyOwner {
        dailyCap = cap;
    }

    /// Credit a user after fiat arrived and tokens were minted to this vault.
    /// `ref` is the off-chain payment reference (e.g. SEPA end-to-end id hash).
    function creditDeposit(address user, uint256 amount, bytes32 ref) external notPaused {
        require(isRamp[msg.sender], "not ramp");
        require(user != address(0), "zero user");
        require(amount > 0, "zero amount");
        require(!processedDeposit[ref], "duplicate deposit");
        processedDeposit[ref] = true;
        // The credited ledger total must be covered by tokens actually held.
        require(token.balanceOf(address(this)) >= totalCredited + amount, "uncovered credit");
        totalCredited += amount;
        balanceOf[user] += amount;
        emit Deposited(user, amount, ref);
    }

    uint256 public totalCredited;

    /// Debit a user's balance for an outbound remittance and move the tokens
    /// to `to` (the orchestrator's working address for the swap leg).
    function debit(address user, uint256 amount, address to, bytes32 transferId) external notPaused {
        require(isOrchestrator[msg.sender], "not orchestrator");
        require(!processedTransfer[transferId], "duplicate transfer");
        require(balanceOf[user] >= amount, "insufficient balance");

        uint256 day = block.timestamp / 1 days;
        require(debitedOnDay[user][day] + amount <= dailyCap, "daily cap exceeded");

        processedTransfer[transferId] = true;
        debitedOnDay[user][day] += amount;
        balanceOf[user] -= amount;
        totalCredited -= amount;

        require(token.transfer(to, amount), "token transfer failed");
        emit Debited(user, amount, to, transferId);
    }
}
