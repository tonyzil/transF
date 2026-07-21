// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @title FxSwapper — swaps tokenIn for tokenOut against its own inventory at
/// an owner-set rate. Stands in for a DEX aggregator route (Uniswap/Aerodrome
/// on Base) in the MVP; the interface is what the orchestrator codes against.
contract FxSwapper {
    IERC20 public immutable tokenIn; // EURe (18 decimals)
    IERC20 public immutable tokenOut; // USDC (6 decimals)
    address public owner;

    /// tokenOut units (6dp) per 1e18 units of tokenIn.
    /// e.g. rate = 1_080_000 means 1 EURe -> 1.08 USDC.
    uint256 public rate;

    event RateSet(uint256 rate);
    event Swapped(address indexed caller, uint256 amountIn, uint256 amountOut, address indexed to);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor(address _tokenIn, address _tokenOut, uint256 _rate) {
        tokenIn = IERC20(_tokenIn);
        tokenOut = IERC20(_tokenOut);
        owner = msg.sender;
        rate = _rate;
    }

    function setRate(uint256 _rate) external onlyOwner {
        require(_rate > 0, "zero rate");
        rate = _rate;
        emit RateSet(_rate);
    }

    function quoteOut(uint256 amountIn) public view returns (uint256) {
        return (amountIn * rate) / 1e18;
    }

    /// Pulls `amountIn` of tokenIn from the caller, pays out tokenOut to `to`.
    /// Reverts if the output is below `minOut` (slippage guard).
    function swapExactIn(uint256 amountIn, uint256 minOut, address to) external returns (uint256 amountOut) {
        amountOut = quoteOut(amountIn);
        require(amountOut >= minOut, "slippage");
        require(tokenOut.balanceOf(address(this)) >= amountOut, "no inventory");
        require(tokenIn.transferFrom(msg.sender, address(this), amountIn), "pull failed");
        require(tokenOut.transfer(to, amountOut), "payout failed");
        emit Swapped(msg.sender, amountIn, amountOut, to);
    }

    /// Owner can withdraw inventory (treasury rebalancing).
    function withdraw(address token, address to, uint256 amount) external onlyOwner {
        require(IERC20(token).transfer(to, amount), "withdraw failed");
    }
}
